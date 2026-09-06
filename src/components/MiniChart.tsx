import { useEffect, useRef, useState } from 'react';
import { createChart, LineStyle, CrosshairMode, type IChartApi, type ISeriesApi, type IPriceLine, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { Candle, TimeframeSec } from '../types';
import { initDuckDB, queryCandles } from '../lib/duckdb';
import { pricePrecision } from '../lib/pips';
import { CHART_FONT_FAMILY, CHART_AXIS_TEXT_COLOR, CHART_AXIS_FONT_SIZE, DASH_TO_STYLE, DASH_TO_CSS } from '../lib/chartTheme';
import { logError } from '../lib/errorLog';
import { ChartHeader } from './ChartHeader';
import { loadChartView, saveChartView, relativeViewToLogicalRange } from '../lib/chartViewState';
import { computeEMA, computeSMA, computeBB, computeCloud } from '../lib/indicators';
import { computeSeparatorBoundaries } from '../lib/weekLines';
import { priceAtTime } from '../lib/crosshairSync';

const toBar = (c: Candle) => ({
  time: c.time as Time,
  open: c.open, high: c.high, low: c.low, close: c.close,
});

const CLICK_TOLERANCE_PX = 6; // これ以下の移動ならパン操作ではなくクリックとみなす

// 4画面レイアウトの表示専用サブパネル。発注・描画などの操作はできず、
// メインチャートのカーソル時刻までに切り詰めて表示するだけ。
// インジケーター（EMA/BB/雲）はメインパネルのON/OFF設定に連動して同じものを表示する。
export function MiniChart({ timeframeSec, label, slot }: { timeframeSec: TimeframeSec; label: string; slot: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const smaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbBasisSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const senkouASeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const senkouBSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const cloudCanvasRef = useRef<HTMLCanvasElement>(null);
  const cloudDataRef = useRef<{ time: number; a: number; b: number }[]>([]);
  const firstVisibleTimeRef = useRef<number | null>(null);
  const syncCloudRef = useRef<() => void>(() => {});
  const weekOverlayRef = useRef<HTMLDivElement>(null);
  const weekLineElsRef = useRef<HTMLDivElement[]>([]);
  const weekBoundariesRef = useRef<number[]>([]);
  const syncWeekLinesRef = useRef<() => void>(() => {});
  const priceLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const vlineOverlayRef = useRef<HTMLDivElement>(null);
  const vlineElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncVLinesRef = useRef<() => void>(() => {});
  const rectOverlayRef = useRef<HTMLDivElement>(null);
  const rectElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncRectsRef = useRef<() => void>(() => {});
  const trendCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncTrendLinesRef = useRef<() => void>(() => {});
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncBrushesRef = useRef<() => void>(() => {});
  const textOverlayRef = useRef<HTMLDivElement>(null);
  const textElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncTextsRef = useRef<() => void>(() => {});
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const [data, setData] = useState<Candle[]>([]);

  const isLoaded = useTraderStore(s => s.isLoaded);
  const dataVersion = useTraderStore(s => s.dataVersion);
  const cursorTime = useTraderStore(s => s.candles[s.cursor]?.time);
  const mainTimeframeSec = useTraderStore(s => s.timeframeSec);
  const symbol = useTraderStore(s => s.symbol);
  const promoteSlotToMain = useTraderStore(s => s.promoteSlotToMain);
  const setQuadTimeframe = useTraderStore(s => s.setQuadTimeframe);
  const showEMA = useTraderStore(s => s.showEMA);
  const showSMA = useTraderStore(s => s.showSMA);
  const showBB = useTraderStore(s => s.showBB);
  const showCloud = useTraderStore(s => s.showCloud);
  const showWeekLines = useTraderStore(s => s.showWeekLines);
  const crosshairSourceId = useTraderStore(s => s.crosshairSourceId);
  const crosshairTime = useTraderStore(s => s.crosshairTime);
  const lines = useTraderStore(s => s.lines);
  const vlines = useTraderStore(s => s.vlines);
  const rects = useTraderStore(s => s.rects);
  const trendLines = useTraderStore(s => s.trendLines);
  const brushes = useTraderStore(s => s.brushes);
  const texts = useTraderStore(s => s.texts);
  const mySourceId = String(slot);
  // メインの現在足が閉じた時点（=これより先の情報は「未来」として隠す境界）
  const cursorEnd = cursorTime !== undefined ? cursorTime + mainTimeframeSec : undefined;

  // CSV読み込み完了のたびに、この時間軸で自前集計
  useEffect(() => {
    if (!isLoaded) { setData([]); return; }
    let cancelled = false;
    (async () => {
      const db = await initDuckDB();
      const candles = await queryCandles(db, timeframeSec);
      if (!cancelled) setData(candles);
    })();
    return () => { cancelled = true; };
  }, [isLoaded, dataVersion, timeframeSec]);

  // チャート初期化（マウント時1回）
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const chart = createChart(container, {
      layout: {
        background: { color: '#0d0d0d' },
        textColor: CHART_AXIS_TEXT_COLOR,
        fontSize: CHART_AXIS_FONT_SIZE,
        fontFamily: CHART_FONT_FAMILY,
      },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      // CandleChartと同じ理由でNormalにする（足の無い空白部分でも十字カーソルを出す）
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#333' }, horzLine: { color: '#333' } },
      rightPriceScale: { borderColor: '#1e1e1e' },
      localization: { locale: 'en-US', dateFormat: 'yy MM/dd' },
      timeScale: {
        borderColor: '#1e1e1e',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => {
          const d = new Date((time as number) * 1000);
          const M = d.getUTCMonth() + 1;
          const D = d.getUTCDate();
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mm = String(d.getUTCMinutes()).padStart(2, '0');
          const yy = String(d.getUTCFullYear()).slice(2);
          return d.getUTCHours() === 0 && d.getUTCMinutes() === 0
            ? `${yy} ${M}/${D}`
            : `${hh}:${mm}`;
        },
      },
      handleScroll: true,
      handleScale: true,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderUpColor: '#26a69a', borderDownColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    const emaSeries = chart.addLineSeries({
      color: '#ffa726', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      visible: false,
    });
    const smaSeries = chart.addLineSeries({
      color: '#ab47bc', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      visible: false,
    });
    const bbLineOptions = {
      lineWidth: 1 as const,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      visible: false,
    };
    const BB_SILVER = '#c0c0c0';
    const bbBasisSeries  = chart.addLineSeries({ ...bbLineOptions, color: '#42a5f5', lineStyle: LineStyle.Solid });
    const bbUpper1Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.SparseDotted });
    const bbLower1Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.SparseDotted });
    const bbUpper2Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.Solid });
    const bbLower2Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.Solid });
    const cloudLineOptions = {
      lineWidth: 1 as const,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      visible: false,
    };
    const senkouASeries = chart.addLineSeries({ ...cloudLineOptions, color: '#26a69a' });
    const senkouBSeries = chart.addLineSeries({ ...cloudLineOptions, color: '#ef5350' });

    chartRef.current = chart;
    seriesRef.current = series;
    emaSeriesRef.current = emaSeries;
    smaSeriesRef.current = smaSeries;
    bbBasisSeriesRef.current  = bbBasisSeries;
    bbUpper1SeriesRef.current = bbUpper1Series;
    bbLower1SeriesRef.current = bbLower1Series;
    bbUpper2SeriesRef.current = bbUpper2Series;
    bbLower2SeriesRef.current = bbLower2Series;
    senkouASeriesRef.current = senkouASeries;
    senkouBSeriesRef.current = senkouBSeries;

    // 実マウス操作で動いた十字カーソルの時刻を他パネルへ共有する
    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = param => {
      if (!param.sourceEvent) return;
      useTraderStore.getState().setCrosshair(mySourceId, (param.time as number | undefined) ?? null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    // 雲（先行スパンA/B）の塗りつぶしを canvas に再描画
    const syncCloud = () => {
      const canvas = cloudCanvasRef.current;
      if (!canvas || !chartRef.current || !seriesRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const { showCloud: show } = useTraderStore.getState();
      const points = cloudDataRef.current;
      if (!show || points.length < 2) return;

      const timeScale = chartRef.current.timeScale();
      const s = seriesRef.current;
      // 表示範囲がローソク足の実データより外側に及んでいても、雲は最初の足より左側には描画しない
      // （timeToCoordinate は範囲外の時刻も外挿してしまうため）
      const leftBoundX = firstVisibleTimeRef.current !== null
        ? timeScale.timeToCoordinate(firstVisibleTimeRef.current as Time)
        : null;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i], p1 = points[i + 1];
        const x0 = timeScale.timeToCoordinate(p0.time as Time);
        const x1 = timeScale.timeToCoordinate(p1.time as Time);
        if (x0 === null || x1 === null) continue;
        if (leftBoundX !== null && x1 <= leftBoundX) continue;
        const ya0 = s.priceToCoordinate(p0.a);
        const ya1 = s.priceToCoordinate(p1.a);
        const yb0 = s.priceToCoordinate(p0.b);
        const yb1 = s.priceToCoordinate(p1.b);
        if (ya0 === null || ya1 === null || yb0 === null || yb1 === null) continue;

        ctx.fillStyle = (p0.a + p1.a) >= (p0.b + p1.b) ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)';
        ctx.beginPath();
        ctx.moveTo(x0, ya0);
        ctx.lineTo(x1, ya1);
        ctx.lineTo(x1, yb1);
        ctx.lineTo(x0, yb0);
        ctx.closePath();
        ctx.fill();
      }
    };
    syncCloudRef.current = syncCloud;

    // 週区切り線の位置を再計算して DOM に反映（控えめなドット線、固定スタイル）
    const syncWeekLines = () => {
      if (!chartRef.current || !weekOverlayRef.current) return;
      const { showWeekLines: show } = useTraderStore.getState();
      const overlay = weekOverlayRef.current;
      overlay.style.display = show ? 'block' : 'none';
      if (!show) return;

      const boundaries = weekBoundariesRef.current;
      const els = weekLineElsRef.current;

      while (els.length < boundaries.length) {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.height = '100%';
        el.style.width = '0px';
        el.style.borderLeft = '1px dashed #4a4a4a';
        el.style.pointerEvents = 'none';
        overlay.appendChild(el);
        els.push(el);
      }
      while (els.length > boundaries.length) {
        els.pop()?.remove();
      }

      boundaries.forEach((t, i) => {
        const x = chartRef.current!.timeScale().timeToCoordinate(t as Time);
        const el = els[i];
        if (x === null) {
          el.style.display = 'none';
        } else {
          el.style.display = 'block';
          el.style.left = `${x}px`;
        }
      });
    };
    syncWeekLinesRef.current = syncWeekLines;

    // 時刻→X座標変換。CandleChartのtimeToXと同じ理由（timeToCoordinateは実在する
    // 足の時刻と完全一致しないとnullを返す）で、このパネル自身の時間軸グリッドに
    // 存在しない時刻（他の時間軸で描いた水平線・垂直線・四角形の時刻）は、表示中の
    // 前後の足を線形補間して位置を求める。表示専用パネルなので範囲外はクランプのみ
    const timeToX = (t: number): number | null => {
      if (!chartRef.current) return null;
      const ts = chartRef.current.timeScale();
      const exact = ts.timeToCoordinate(t as Time);
      if (exact !== null) return exact;
      const visible = visibleDataRef.current;
      if (visible.length === 0) return null;
      if (t <= visible[0].time) return ts.timeToCoordinate(visible[0].time as Time);
      if (t >= visible[visible.length - 1].time) return ts.timeToCoordinate(visible[visible.length - 1].time as Time);
      let lo = 0, hi = visible.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (visible[mid].time <= t) lo = mid; else hi = mid;
      }
      const x0 = ts.timeToCoordinate(visible[lo].time as Time);
      const x1 = ts.timeToCoordinate(visible[hi].time as Time);
      if (x0 === null || x1 === null) return null;
      const frac = (t - visible[lo].time) / (visible[hi].time - visible[lo].time);
      return x0 + frac * (x1 - x0);
    };

    // 垂直線の位置を再計算して DOM に反映（表示専用、ドラッグ操作なし）
    const syncVLines = () => {
      if (!chartRef.current || !vlineOverlayRef.current) return;
      const { vlines: currentVLines } = useTraderStore.getState();
      const overlay = vlineOverlayRef.current;
      const existing = vlineElsRef.current;
      const nextIds = new Set(currentVLines.map(v => v.id));

      for (const [id, el] of existing) {
        if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
      }

      for (const v of currentVLines) {
        let el = existing.get(v.id);
        if (!el) {
          el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.top = '0';
          el.style.height = '100%';
          el.style.width = '0px';
          el.style.pointerEvents = 'none';
          overlay.appendChild(el);
          existing.set(v.id, el);
        }
        const x = timeToX(v.time);
        if (x === null) {
          el.style.display = 'none';
        } else {
          el.style.display = 'block';
          el.style.left = `${x}px`;
          el.style.borderLeft = `${v.width}px ${DASH_TO_CSS[v.dash]} ${v.color}`;
        }
      }
    };
    syncVLinesRef.current = syncVLines;

    // 四角形の位置を再計算して DOM に反映（表示専用、ドラッグ操作なし）
    const syncRects = () => {
      if (!chartRef.current || !seriesRef.current || !rectOverlayRef.current) return;
      const { rects: currentRects } = useTraderStore.getState();
      const overlay = rectOverlayRef.current;
      const existing = rectElsRef.current;
      const nextIds = new Set(currentRects.map(r => r.id));

      for (const [id, el] of existing) {
        if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
      }

      for (const r of currentRects) {
        let el = existing.get(r.id);
        if (!el) {
          el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.pointerEvents = 'none';
          overlay.appendChild(el);
          existing.set(r.id, el);
        }
        const x1 = timeToX(r.time1);
        const x2 = timeToX(r.time2);
        const y1 = seriesRef.current.priceToCoordinate(r.price1);
        const y2 = seriesRef.current.priceToCoordinate(r.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) {
          el.style.display = 'none';
          continue;
        }
        el.style.display = 'block';
        el.style.left = `${Math.min(x1, x2)}px`;
        el.style.top = `${Math.min(y1, y2)}px`;
        el.style.width = `${Math.abs(x2 - x1)}px`;
        el.style.height = `${Math.abs(y2 - y1)}px`;
        el.style.border = `${r.width}px ${DASH_TO_CSS[r.dash]} ${r.color}`;
      }
    };
    syncRectsRef.current = syncRects;

    // トレンドラインを canvas に再描画（表示専用、ドラッグ操作なし）。斜めの線分なので
    // 四角形のようなDOMのborderでは表現できず、雲と同じcanvas方式にする
    const syncTrendLines = () => {
      const canvas = trendCanvasRef.current;
      if (!canvas || !chartRef.current || !seriesRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const { trendLines: currentTrendLines } = useTraderStore.getState();
      const DASH_TO_CANVAS: Record<'solid' | 'dashed' | 'dotted', number[]> = {
        solid: [], dashed: [7, 5], dotted: [1, 4],
      };
      for (const tl of currentTrendLines) {
        const x1 = timeToX(tl.time1), x2 = timeToX(tl.time2);
        const y1 = seriesRef.current.priceToCoordinate(tl.price1), y2 = seriesRef.current.priceToCoordinate(tl.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        ctx.save();
        ctx.strokeStyle = tl.color;
        ctx.lineWidth = tl.width;
        ctx.setLineDash(DASH_TO_CANVAS[tl.dash]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
    };
    syncTrendLinesRef.current = syncTrendLines;

    // ブラシ（フリーハンド）を canvas に再描画（表示専用、ドラッグ操作なし）
    const syncBrushes = () => {
      const canvas = brushCanvasRef.current;
      if (!canvas || !chartRef.current || !seriesRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const { brushes: currentBrushes } = useTraderStore.getState();
      for (const b of currentBrushes) {
        const pixelPoints: { x: number; y: number }[] = [];
        for (const p of b.points) {
          const x = timeToX(p.time);
          const y = seriesRef.current.priceToCoordinate(p.price);
          if (x === null || y === null) continue;
          pixelPoints.push({ x, y });
        }
        if (pixelPoints.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
        // CandleChart側と同じ2次ベジェによる手書き線平滑化（詳細はそちらのコメント参照）
        for (let i = 1; i < pixelPoints.length - 1; i++) {
          const midX = (pixelPoints[i].x + pixelPoints[i + 1].x) / 2;
          const midY = (pixelPoints[i].y + pixelPoints[i + 1].y) / 2;
          ctx.quadraticCurveTo(pixelPoints[i].x, pixelPoints[i].y, midX, midY);
        }
        const last = pixelPoints[pixelPoints.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        ctx.restore();
      }
    };
    syncBrushesRef.current = syncBrushes;

    // テキストボックスの位置を再計算してDOMに反映（表示専用、ドラッグ操作なし）
    const syncTexts = () => {
      if (!chartRef.current || !seriesRef.current || !textOverlayRef.current) return;
      const { texts: currentTexts } = useTraderStore.getState();
      const overlay = textOverlayRef.current;
      const existing = textElsRef.current;
      const nextIds = new Set(currentTexts.map(t => t.id));

      for (const [id, el] of existing) {
        if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
      }

      for (const t of currentTexts) {
        let el = existing.get(t.id);
        if (!el) {
          el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.pointerEvents = 'none';
          el.style.whiteSpace = 'pre';
          el.style.fontFamily = CHART_FONT_FAMILY;
          el.style.padding = '1px 3px';
          overlay.appendChild(el);
          existing.set(t.id, el);
        }
        const x = timeToX(t.time);
        const y = seriesRef.current.priceToCoordinate(t.price);
        if (x === null || y === null) { el.style.display = 'none'; continue; }
        el.style.display = 'block';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.fontSize = `${t.fontSize}px`;
        el.style.color = t.color;
        el.style.border = t.border === 'none' ? '1px solid transparent' : `1px ${DASH_TO_CSS[t.border]} ${t.color}`;
        el.textContent = t.text;
      }
    };
    syncTextsRef.current = syncTexts;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      syncCloud();
      syncWeekLines();
      syncVLines();
      syncRects();
      syncTrendLines();
      syncBrushes();
      syncTexts();
    });
    ro.observe(container);

    // 表示中のズーム/スケールを時間軸ごとに記憶（連続発火するため軽くデバウンス）
    let saveViewTimer: number | undefined;
    const onRangeChange = () => {
      syncCloud();
      syncWeekLines();
      syncVLines();
      syncRects();
      syncTrendLines();
      syncBrushes();
      syncTexts();
      if (saveViewTimer !== undefined) window.clearTimeout(saveViewTimer);
      saveViewTimer = window.setTimeout(() => {
        if (!chartRef.current) return;
        const range = chartRef.current.timeScale().getVisibleLogicalRange();
        if (!range || visibleCountRef.current <= 0) return;
        saveChartView(timeframeSec, { span: range.to - range.from, barsFromRight: visibleCountRef.current - range.to });
      }, 400);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      if (saveViewTimer !== undefined) window.clearTimeout(saveViewTimer);
      weekLineElsRef.current.forEach(el => el.remove());
      weekLineElsRef.current = [];
      vlineElsRef.current.forEach(el => el.remove());
      vlineElsRef.current.clear();
      rectElsRef.current.forEach(el => el.remove());
      rectElsRef.current.clear();
      textElsRef.current.forEach(el => el.remove());
      textElsRef.current.clear();
      priceLineMapRef.current.clear();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [timeframeSec]);

  // 水平線の再描画（表示専用）。チャート破棄タイミングの例外はCandleChartと同じ理由で
  // try/catchで吸収し、画面クラッシュを防ぐ
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
      const existing = priceLineMapRef.current;
      const nextIds = new Set(lines.map(l => l.id));
      for (const [id, priceLine] of existing) {
        if (!nextIds.has(id)) { series.removePriceLine(priceLine); existing.delete(id); }
      }
      for (const line of lines) {
        const opts = {
          price: line.price,
          color: line.color,
          lineWidth: line.width,
          lineStyle: DASH_TO_STYLE[line.dash],
          axisLabelVisible: true,
        };
        const current = existing.get(line.id);
        if (current) current.applyOptions(opts);
        else existing.set(line.id, series.createPriceLine(opts));
      }
    } catch (e) {
      logError('MiniChart:hlines', e);
    }
  }, [lines]);

  useEffect(() => {
    syncVLinesRef.current();
  }, [vlines]);

  useEffect(() => {
    syncRectsRef.current();
  }, [rects]);

  useEffect(() => {
    syncTrendLinesRef.current();
  }, [trendLines]);

  useEffect(() => {
    syncBrushesRef.current();
  }, [brushes]);

  useEffect(() => {
    syncTextsRef.current();
  }, [texts]);

  // 他パネルの十字カーソルに追従表示する（自分がホバー元のときは何もしない）
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current || crosshairSourceId === mySourceId) return;
    try {
      if (crosshairTime === null) {
        chartRef.current.clearCrosshairPosition();
        return;
      }
      const price = priceAtTime(visibleDataRef.current, crosshairTime, timeframeSec);
      if (price === null) { chartRef.current.clearCrosshairPosition(); return; }
      chartRef.current.setCrosshairPosition(price, crosshairTime as Time, seriesRef.current);
    } catch (e) {
      logError('MiniChart:crosshairSync', e);
    }
  }, [crosshairSourceId, crosshairTime, data, mySourceId]);

  // インジケーター ON/OFF（非表示中も裏では計算済みのまま保持、canvasはsyncCloud内で判定）
  useEffect(() => {
    emaSeriesRef.current?.applyOptions({ visible: showEMA });
  }, [showEMA]);
  useEffect(() => {
    smaSeriesRef.current?.applyOptions({ visible: showSMA });
  }, [showSMA]);
  useEffect(() => {
    bbBasisSeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper1SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower1SeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper2SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower2SeriesRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);
  useEffect(() => {
    senkouASeriesRef.current?.applyOptions({ visible: showCloud });
    senkouBSeriesRef.current?.applyOptions({ visible: showCloud });
    syncCloudRef.current();
  }, [showCloud]);
  useEffect(() => {
    syncWeekLinesRef.current();
  }, [showWeekLines]);

  // 新しいデータセットに切り替わった時だけ画面フィットしたか（同じデータ中はスケールを保持する）
  const fittedDataRef = useRef<Candle[] | null>(null);
  const visibleCountRef = useRef(0);
  const visibleDataRef = useRef<Candle[]>([]);

  // データ・カーソル位置に応じて描画。バケット終了時刻がメインの現在足の終了時刻を
  // 超える（＝まだ閉じていない）足は先出しになるため描画しない
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;
    const visible = cursorEnd === undefined
      ? data
      : data.filter(c => c.time + timeframeSec <= cursorEnd);
    if (visible.length === 0) return;

    const precision = pricePrecision(visible[visible.length - 1].close);
    const priceFormat = { type: 'price' as const, precision, minMove: 1 / 10 ** precision };
    seriesRef.current.applyOptions({ priceFormat });
    seriesRef.current.setData(visible.map(toBar));
    visibleCountRef.current = visible.length;
    visibleDataRef.current = visible;
    firstVisibleTimeRef.current = visible[0].time;

    emaSeriesRef.current?.applyOptions({ priceFormat });
    emaSeriesRef.current?.setData(computeEMA(visible));

    smaSeriesRef.current?.applyOptions({ priceFormat });
    smaSeriesRef.current?.setData(computeSMA(visible));

    const bb = computeBB(visible);
    bbBasisSeriesRef.current?.applyOptions({ priceFormat });
    bbBasisSeriesRef.current?.setData(bb.basis);
    bbUpper1SeriesRef.current?.setData(bb.upper1);
    bbLower1SeriesRef.current?.setData(bb.lower1);
    bbUpper2SeriesRef.current?.setData(bb.upper2);
    bbLower2SeriesRef.current?.setData(bb.lower2);

    const cloud = computeCloud(visible, timeframeSec, data);
    senkouASeriesRef.current?.applyOptions({ priceFormat });
    senkouASeriesRef.current?.setData(cloud.senkouA);
    senkouBSeriesRef.current?.setData(cloud.senkouB);
    cloudDataRef.current = cloud.points;
    syncCloudRef.current();

    weekBoundariesRef.current = computeSeparatorBoundaries(visible, timeframeSec);
    syncWeekLinesRef.current();
    syncVLinesRef.current();
    syncRectsRef.current();
    syncTrendLinesRef.current();
    syncTextsRef.current();

    // カーソル進行のたびに毎回フィットすると、序盤の少数本だけを見て過剰拡大されるため、
    // 新規データ読み込み時（全期間の時間幅）だけ一度フィットし、以降は同じスケールを維持する。
    // 記憶済みのズーム/スケールがあればそちらを優先して復元する
    if (fittedDataRef.current !== data) {
      fittedDataRef.current = data;
      const saved = loadChartView(timeframeSec);
      if (saved) {
        chartRef.current?.timeScale().setVisibleLogicalRange(relativeViewToLogicalRange(saved, visible.length));
      } else {
        chartRef.current?.timeScale().setVisibleRange({
          from: data[0].time as Time,
          to: data[data.length - 1].time as Time,
        });
      }
      syncCloudRef.current();
      syncWeekLinesRef.current();
      syncVLinesRef.current();
      syncRectsRef.current();
      syncTrendLinesRef.current();
      syncBrushesRef.current();
      syncTextsRef.current();
    }

    // timeToCoordinate等の時刻ベース座標変換は、setData/setVisibleRange直後の
    // レイアウト未確定なタイミングだと稀に古い座標を返し、雲や週区切り線がずれて
    // 描画されることがある（CandleChart側の同種の注記を参照）。1フレーム後に
    // 再同期して、その場合でも正しい座標で描き直す
    const raf = requestAnimationFrame(() => {
      syncCloudRef.current();
      syncWeekLinesRef.current();
      syncVLinesRef.current();
      syncRectsRef.current();
      syncTrendLinesRef.current();
      syncBrushesRef.current();
      syncTextsRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [data, cursorEnd, timeframeSec]);

  return (
    <div
      onMouseDown={e => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
      onMouseUp={e => {
        const start = mouseDownPosRef.current;
        mouseDownPosRef.current = null;
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        // パン/ズーム操作（ドラッグ）と区別し、ほぼ動いていない場合だけクリックとみなす
        if (Math.hypot(dx, dy) <= CLICK_TOLERANCE_PX) promoteSlotToMain(slot);
      }}
      onMouseLeave={() => {
        const s = useTraderStore.getState();
        if (s.crosshairSourceId === mySourceId) s.setCrosshair(null, null);
      }}
      title="クリックでメインパネルに切り替え"
      style={{
        width: '100%', height: '100%', position: 'relative',
        border: '1px solid #1e1e1e', minWidth: 0, minHeight: 0, cursor: 'pointer',
      }}
    >
      <ChartHeader
        symbol={symbol}
        timeframeLabel={label}
        timeframeSec={timeframeSec}
        onSelectTimeframe={sec => setQuadTimeframe(slot, sec)}
        disabled={!isLoaded}
      />
      <canvas ref={cloudCanvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%', zIndex: 5 }} />
      <div ref={rectOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 9 }} />
      <canvas ref={trendCanvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%', zIndex: 9 }} />
      <canvas ref={brushCanvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%', zIndex: 9 }} />
      <div ref={textOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 9 }} />
      <div ref={weekOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 10 }} />
      <div ref={vlineOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 11 }} />
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
