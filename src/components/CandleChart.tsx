import { useEffect, useRef } from 'react';
import {
  createChart, LineStyle,
  type IChartApi, type ISeriesApi, type CandlestickSeriesOptions,
  type Time, type UTCTimestamp, type CandlestickData, type LineData, type IPriceLine,
  type SeriesMarker,
} from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { Candle, LineDash, Position, ClosedTrade } from '../types';
import { currencySymbol } from '../lib/currency';
import { inferPipSize, pricePrecision } from '../lib/pips';

// 水平方向にドラッグ可能な対象（水平線 / 未約定注文 / TP / SL）
type DragTarget =
  | { kind: 'hline'; id: number }
  | { kind: 'order'; id: number }
  | { kind: 'tp'; id: number }
  | { kind: 'sl'; id: number }
  | { kind: 'orderTp'; id: number }
  | { kind: 'orderSl'; id: number };

const EMA_PERIOD = 200;
const BB_PERIOD = 20;
const DRAG_TOLERANCE_PX = 6;

const DASH_TO_STYLE: Record<LineDash, LineStyle> = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
};

const DASH_TO_CSS: Record<LineDash, string> = {
  solid: 'solid',
  dashed: 'dashed',
  dotted: 'dotted',
};

const toBar = (c: Candle): CandlestickData => ({
  time: c.time as Time,
  open: c.open, high: c.high, low: c.low, close: c.close,
});

// 月曜 00:00 UTC（その時刻が属する週の開始）
function mondayOfWeekUTC(sec: number): number {
  const d = new Date(sec * 1000);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday) / 1000);
}

function computeWeekBoundaries(candles: Candle[]): number[] {
  if (candles.length === 0) return [];
  const last = candles[candles.length - 1].time;
  const WEEK = 7 * 86400;
  const boundaries: number[] = [];
  for (let t = mondayOfWeekUTC(candles[0].time); t <= last; t += WEEK) {
    boundaries.push(t);
  }
  return boundaries;
}

function fmtDuration(sec: number): string {
  const abs = Math.abs(sec);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((abs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function candleIndexAt(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

// オープン中ポジション + 決済済みトレードからエントリー/決済マーカーを構築
function buildTradeMarkers(positions: Position[], closedTrades: ClosedTrade[], sym: string): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];

  for (const pos of positions) {
    const isBuy = pos.side === 'BUY';
    markers.push({
      time: pos.openTime as Time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#26a69a' : '#ef5350',
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      text: pos.side,
    });
  }

  for (const t of closedTrades) {
    const isBuy = t.side === 'BUY';
    markers.push({
      time: t.openTime as Time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#26a69a' : '#ef5350',
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      text: t.side,
    });
    markers.push({
      time: t.closeTime as Time,
      position: isBuy ? 'aboveBar' : 'belowBar',
      color: t.pnl >= 0 ? '#26a69a' : '#ef5350',
      shape: 'circle',
      text: `${t.pnl >= 0 ? '+' : ''}${sym}${Math.round(t.pnl).toLocaleString()}`,
    });
  }

  markers.sort((a, b) => (a.time as number) - (b.time as number));
  return markers;
}

export function CandleChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const weekOverlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbBasisSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpper2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLower2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const tpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const slLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderTpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderSlLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const draftLineMapRef = useRef<Map<'price' | 'tp' | 'sl', IPriceLine>>(new Map());
  const vlineElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncVLinesRef = useRef<() => void>(() => {});
  const weekLineElsRef = useRef<HTMLDivElement[]>([]);
  const weekBoundariesRef = useRef<number[]>([]);
  const syncWeekLinesRef = useRef<() => void>(() => {});
  const measureOverlayRef = useRef<HTMLDivElement>(null);
  const measureBoxRef = useRef<HTMLDivElement>(null);
  const measureMidLineRef = useRef<HTMLDivElement>(null);
  const measureLabelRef = useRef<HTMLDivElement>(null);
  const rrOverlayRef = useRef<HTMLDivElement>(null);
  const rrTpBoxRef = useRef<HTMLDivElement>(null);
  const rrSlBoxRef = useRef<HTMLDivElement>(null);
  const rrLabelRef = useRef<HTMLDivElement>(null);
  const updateRRPreviewRef = useRef<() => void>(() => {});

  const candles = useTraderStore(s => s.candles);
  const cursor    = useTraderStore(s => s.cursor);
  const positions = useTraderStore(s => s.positions);
  const pendingOrders = useTraderStore(s => s.pendingOrders);
  const closedTrades = useTraderStore(s => s.closedTrades);
  const quoteCurrency = useTraderStore(s => s.quoteCurrency);
  const lines     = useTraderStore(s => s.lines);
  const vlines    = useTraderStore(s => s.vlines);
  const isDrawingLine  = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring    = useTraderStore(s => s.isMeasuring);
  const pickTarget     = useTraderStore(s => s.pickTarget);
  const orderType      = useTraderStore(s => s.orderType);
  const draftPrice     = useTraderStore(s => s.draftPrice);
  const draftTP        = useTraderStore(s => s.draftTP);
  const draftSL        = useTraderStore(s => s.draftSL);
  const showEMA   = useTraderStore(s => s.showEMA);
  const showBB    = useTraderStore(s => s.showBB);
  const showWeekLines = useTraderStore(s => s.showWeekLines);
  const showFullHistory = useTraderStore(s => s.showFullHistory);
  const fitSignal  = useTraderStore(s => s.fitSignal);
  const centerSignal = useTraderStore(s => s.centerSignal);
  const centerTarget = useTraderStore(s => s.centerTarget);

  const prevCursorRef  = useRef(-1);
  const prevCandlesRef = useRef<Candle[]>([]);

  // EMA 増分計算用の状態
  const emaValueRef = useRef(0);
  const emaSumRef   = useRef(0);
  const emaCountRef = useRef(0);

  // ボリンジャーバンド（移動窓の合計・二乗和で SMA・標準偏差を差分更新）
  const bbSumRef   = useRef(0);
  const bbSumSqRef = useRef(0);

  // チャート初期化（マウント時1回のみ）
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const chart = createChart(container, {
      layout: {
        background: { color: '#0d0d0d' },
        textColor: '#888',
        fontSize: 14,
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a' },
      },
      crosshair: {
        vertLine: { color: '#333' },
        horzLine: { color: '#333' },
      },
      rightPriceScale: {
        borderColor: '#1e1e1e',
      },
      localization: {
        locale: 'en-US',
        dateFormat: 'yy MM/dd',
      },
      timeScale: {
        borderColor: '#1e1e1e',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
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
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const seriesOptions: Partial<CandlestickSeriesOptions> = {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    };
    const series = chart.addCandlestickSeries(seriesOptions);
    const emaSeries = chart.addLineSeries({
      color: '#ffa726',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const bbLineOptions = {
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      visible: false,
    };
    const BB_SILVER = '#c0c0c0';
    const bbBasisSeries  = chart.addLineSeries({ ...bbLineOptions, color: '#42a5f5', lineStyle: LineStyle.Solid });
    const bbUpper1Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.SparseDotted });
    const bbLower1Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.SparseDotted });
    const bbUpper2Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.Solid });
    const bbLower2Series = chart.addLineSeries({ ...bbLineOptions, color: BB_SILVER, lineStyle: LineStyle.Solid });

    chartRef.current = chart;
    seriesRef.current = series;
    emaSeriesRef.current = emaSeries;
    bbBasisSeriesRef.current  = bbBasisSeries;
    bbUpper1SeriesRef.current = bbUpper1Series;
    bbLower1SeriesRef.current = bbLower1Series;
    bbUpper2SeriesRef.current = bbUpper2Series;
    bbLower2SeriesRef.current = bbLower2Series;

    // ── 垂直線の位置を再計算して DOM に反映 ────────────────────────
    const syncVLines = () => {
      if (!chartRef.current || !overlayRef.current) return;
      const { vlines: currentVLines } = useTraderStore.getState();
      const overlay = overlayRef.current;
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
        const x = chartRef.current.timeScale().timeToCoordinate(v.time as Time);
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
    syncVLines();

    // ── 週区切り線の位置を再計算して DOM に反映（控えめなドット線、固定スタイル） ──
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
    syncWeekLines();

    // ── 発注パネルの draft 価格から リスクリワード（TP/SL比率）をプレビュー ──
    const RR_BOX_WIDTH = 70; // px

    const updateRRPreview = () => {
      if (!seriesRef.current || !chartRef.current) return;
      if (!rrOverlayRef.current || !rrTpBoxRef.current || !rrSlBoxRef.current || !rrLabelRef.current) return;
      const overlay = rrOverlayRef.current;
      const tpBox = rrTpBoxRef.current;
      const slBox = rrSlBoxRef.current;
      const label = rrLabelRef.current;

      const { orderType: ot, draftPrice: dp, draftTP: dtp, draftSL: dsl, candles: cs, cursor: cur } = useTraderStore.getState();
      const c = cs[cur];
      const entryPrice = ot === 'market' ? c?.close ?? null : dp;

      if (!c || entryPrice === null || (dtp === null && dsl === null)) {
        overlay.style.display = 'none';
        return;
      }

      const x1 = chartRef.current.timeScale().timeToCoordinate(c.time as Time);
      const yEntry = seriesRef.current.priceToCoordinate(entryPrice);
      if (x1 === null || yEntry === null) {
        overlay.style.display = 'none';
        return;
      }
      const x2 = x1 + RR_BOX_WIDTH;
      overlay.style.display = 'block';

      if (dtp !== null) {
        const yTp = seriesRef.current.priceToCoordinate(dtp);
        if (yTp !== null) {
          tpBox.style.display = 'block';
          tpBox.style.left = `${x1}px`;
          tpBox.style.width = `${RR_BOX_WIDTH}px`;
          tpBox.style.top = `${Math.min(yEntry, yTp)}px`;
          tpBox.style.height = `${Math.abs(yTp - yEntry)}px`;
        } else {
          tpBox.style.display = 'none';
        }
      } else {
        tpBox.style.display = 'none';
      }

      if (dsl !== null) {
        const ySl = seriesRef.current.priceToCoordinate(dsl);
        if (ySl !== null) {
          slBox.style.display = 'block';
          slBox.style.left = `${x1}px`;
          slBox.style.width = `${RR_BOX_WIDTH}px`;
          slBox.style.top = `${Math.min(yEntry, ySl)}px`;
          slBox.style.height = `${Math.abs(ySl - yEntry)}px`;
        } else {
          slBox.style.display = 'none';
        }
      } else {
        slBox.style.display = 'none';
      }

      if (dtp !== null && dsl !== null) {
        const risk = Math.abs(entryPrice - dsl);
        const reward = Math.abs(dtp - entryPrice);
        const ratio = risk > 0 ? reward / risk : 0;
        label.textContent = `R:R 1 : ${ratio.toFixed(2)}`;
        label.style.display = 'block';
        label.style.left = `${x2 + 6}px`;
        label.style.top = `${yEntry}px`;
      } else {
        label.style.display = 'none';
      }
    };
    updateRRPreviewRef.current = updateRRPreview;
    updateRRPreview();

    const onRangeChange = () => { syncVLines(); syncWeekLines(); updateRRPreview(); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // クリックで水平線 / 垂直線を配置、または 指値・TP・SL の価格を取得（各モード中のみ）
    chart.subscribeClick(param => {
      const { isDrawingLine: drawingH, isDrawingVLine: drawingV, pickTarget, addLine, addVLine, pickPrice } = useTraderStore.getState();
      if (!param.point || !seriesRef.current) return;

      if (pickTarget !== null) {
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (price !== null) pickPrice(price);
        return;
      }
      if (drawingH) {
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (price !== null) addLine(price);
        return;
      }
      if (drawingV && chartRef.current) {
        const time = chartRef.current.timeScale().coordinateToTime(param.point.x);
        if (time !== null) addVLine(time as number);
      }
    });

    // ── ものさし（ドラッグで価格差・本数・期間を計測） ──────────────
    let measuringDrag = false;
    let measureStart: { x: number; y: number; price: number; time: number } | null = null;

    const updateMeasureBox = (x1: number, y1: number, x2: number, y2: number) => {
      if (!measureOverlayRef.current || !measureBoxRef.current || !measureLabelRef.current) return;
      if (!measureStart || !seriesRef.current || !chartRef.current) return;
      const overlay = measureOverlayRef.current;
      const box = measureBoxRef.current;
      const label = measureLabelRef.current;

      const endPrice = seriesRef.current.coordinateToPrice(y2);
      const endTime = chartRef.current.timeScale().coordinateToTime(x2);
      if (endPrice === null) return;

      overlay.style.display = 'block';

      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);

      // ドラッグ方向に依存させず、常に画面左→右（時系列順）を基準に差分を出す
      const leftIsStart = x1 <= x2;
      const leftPrice  = leftIsStart ? measureStart.price : endPrice;
      const rightPrice = leftIsStart ? endPrice : measureStart.price;
      const priceDiff = rightPrice - leftPrice;
      const pct = (priceDiff / leftPrice) * 100;
      const up = priceDiff >= 0;
      const color = up ? '#26a69a' : '#ef5350';

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.border = `1px solid ${color}`;
      box.style.backgroundColor = up ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';

      // 上下の中央線（始点・終点価格の中間値を示す横線）
      if (measureMidLineRef.current) {
        const mid = measureMidLineRef.current;
        mid.style.display = 'block';
        mid.style.left = `${left}px`;
        mid.style.top = `${(y1 + y2) / 2}px`;
        mid.style.width = `${width}px`;
        mid.style.borderTop = `1px dashed ${color}`;
      }

      let barText = '';
      if (endTime !== null) {
        const { candles: cs } = useTraderStore.getState();
        if (cs.length > 0) {
          const bars = Math.abs(candleIndexAt(cs, endTime as number) - candleIndexAt(cs, measureStart.time));
          const dur = fmtDuration((endTime as number) - measureStart.time);
          barText = `${bars}本 · ${dur}`;
        }
      }

      const pipSize = inferPipSize(leftPrice);
      const pips = priceDiff / pipSize;

      label.innerHTML = '';
      const priceLine = document.createElement('div');
      priceLine.style.color = color;
      priceLine.style.fontWeight = '700';
      priceLine.style.fontSize = '16px';
      priceLine.textContent = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(pricePrecision(leftPrice))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      const pipsLine = document.createElement('div');
      pipsLine.style.color = color;
      pipsLine.style.fontSize = '14px';
      pipsLine.style.marginTop = '2px';
      pipsLine.textContent = `${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips`;
      const barLine = document.createElement('div');
      barLine.style.color = '#aaa';
      barLine.style.fontSize = '14px';
      barLine.style.marginTop = '2px';
      barLine.textContent = barText;
      label.appendChild(priceLine);
      label.appendChild(pipsLine);
      label.appendChild(barLine);

      label.style.display = 'block';
      label.style.left = `${x2 + 8}px`;
      label.style.top = `${y2}px`;
    };

    // ── 既存ライン（水平線・垂直線・注文・TP/SL）のドラッグ移動 ──────
    let draggingTarget: DragTarget | null = null;
    let draggingVId: number | null = null;
    let draggingDraft: 'price' | 'tp' | 'sl' | null = null;
    let pendingPrice: number | null = null;
    let pendingVX: number | null = null;
    let pendingDraftPrice: number | null = null;
    let rafScheduled = false;

    // 発注パネルの draft 価格（price/TP/SL）のプレビュー線をドラッグで調整
    const findDraftNear = (y: number): 'price' | 'tp' | 'sl' | null => {
      if (!seriesRef.current) return null;
      const { orderType: ot, draftPrice: dp, draftTP: dtp, draftSL: dsl } = useTraderStore.getState();
      if (ot !== 'market' && dp !== null) {
        const ly = seriesRef.current.priceToCoordinate(dp);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'price';
      }
      if (dtp !== null) {
        const ly = seriesRef.current.priceToCoordinate(dtp);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'tp';
      }
      if (dsl !== null) {
        const ly = seriesRef.current.priceToCoordinate(dsl);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'sl';
      }
      return null;
    };

    const priceLineMapFor = (kind: DragTarget['kind']): Map<number, IPriceLine> => {
      if (kind === 'hline') return priceLineMapRef.current;
      if (kind === 'order') return orderLineMapRef.current;
      if (kind === 'tp') return tpLineMapRef.current;
      if (kind === 'sl') return slLineMapRef.current;
      if (kind === 'orderTp') return orderTpLineMapRef.current;
      return orderSlLineMapRef.current;
    };

    const findPriceTargetNear = (y: number): DragTarget | null => {
      if (!seriesRef.current) return null;
      const { lines: currentLines, pendingOrders: currentOrders, positions: currentPositions } = useTraderStore.getState();
      for (const line of currentLines) {
        const ly = seriesRef.current.priceToCoordinate(line.price);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'hline', id: line.id };
      }
      for (const order of currentOrders) {
        const ly = seriesRef.current.priceToCoordinate(order.price);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'order', id: order.id };
        if (order.tp !== undefined) {
          const tly = seriesRef.current.priceToCoordinate(order.tp);
          if (tly !== null && Math.abs(tly - y) <= DRAG_TOLERANCE_PX) return { kind: 'orderTp', id: order.id };
        }
        if (order.sl !== undefined) {
          const sly = seriesRef.current.priceToCoordinate(order.sl);
          if (sly !== null && Math.abs(sly - y) <= DRAG_TOLERANCE_PX) return { kind: 'orderSl', id: order.id };
        }
      }
      for (const pos of currentPositions) {
        if (pos.tp !== undefined) {
          const ly = seriesRef.current.priceToCoordinate(pos.tp);
          if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'tp', id: pos.id };
        }
        if (pos.sl !== undefined) {
          const ly = seriesRef.current.priceToCoordinate(pos.sl);
          if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'sl', id: pos.id };
        }
      }
      return null;
    };

    const findVLineNear = (x: number): number | null => {
      if (!chartRef.current) return null;
      const { vlines: currentVLines } = useTraderStore.getState();
      for (const v of currentVLines) {
        const vx = chartRef.current.timeScale().timeToCoordinate(v.time as Time);
        if (vx !== null && Math.abs(vx - x) <= DRAG_TOLERANCE_PX) return v.id;
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, pickTarget: pick } = useTraderStore.getState();
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (pick !== null) return;

      if (isM) {
        if (!seriesRef.current || !chartRef.current) return;
        const price = seriesRef.current.coordinateToPrice(y);
        const time = chartRef.current.timeScale().coordinateToTime(x);
        if (price === null || time === null) return;
        measureStart = { x, y, price, time: time as number };
        measuringDrag = true;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        updateMeasureBox(x, y, x, y);
        return;
      }

      if (dH || dV) return;

      const draft = findDraftNear(y);
      if (draft !== null) {
        draggingDraft = draft;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'ns-resize';
        return;
      }

      const target = findPriceTargetNear(y);
      if (target !== null) {
        draggingTarget = target;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'ns-resize';
        return;
      }
      const vId = findVLineNear(x);
      if (vId !== null) {
        draggingVId = vId;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'ew-resize';
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (measuringDrag && measureStart) {
        updateMeasureBox(measureStart.x, measureStart.y, x, y);
        return;
      }

      if (draggingDraft !== null) {
        if (!seriesRef.current) return;
        const price = seriesRef.current.coordinateToPrice(y);
        if (price === null) return;
        pendingDraftPrice = price;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            // draft はストア値そのものなので直接コミットする（既存の描画系がそのまま追従する）
            if (draggingDraft !== null && pendingDraftPrice !== null) {
              const store = useTraderStore.getState();
              if (draggingDraft === 'price') store.setDraftPrice(pendingDraftPrice);
              else if (draggingDraft === 'tp') store.setDraftTP(pendingDraftPrice);
              else store.setDraftSL(pendingDraftPrice);
            }
          });
        }
        return;
      }

      if (draggingTarget !== null) {
        if (!seriesRef.current) return;
        const price = seriesRef.current.coordinateToPrice(y);
        if (price === null) return;
        // 丸めない（0.001刻みなどに量子化すると、ズーム次第で複数px分の
        // ジャンプになり「カクつく」原因になる。表示側だけ toFixed で丸める）
        pendingPrice = price;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            // ドラッグ中は store を経由せず、チャート側のラインを直接動かす
            // （store → React 再レンダリング往復のラグでカクつくのを避ける）
            if (draggingTarget !== null && pendingPrice !== null) {
              priceLineMapFor(draggingTarget.kind).get(draggingTarget.id)?.applyOptions({ price: pendingPrice });
            }
          });
        }
        return;
      }

      if (draggingVId !== null) {
        pendingVX = x;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (draggingVId !== null && pendingVX !== null) {
              const el = vlineElsRef.current.get(draggingVId);
              if (el) el.style.left = `${pendingVX}px`;
            }
          });
        }
        return;
      }

      // ドラッグ中でなければ、ライン近傍でカーソルをホバー表示に
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, pickTarget: pick } = useTraderStore.getState();
      if (!dH && !dV && !isM && pick === null) {
        const draft = findDraftNear(y);
        if (draft !== null) { container.style.cursor = 'ns-resize'; return; }
        const target = findPriceTargetNear(y);
        if (target !== null) { container.style.cursor = 'ns-resize'; return; }
        const vId = findVLineNear(x);
        container.style.cursor = vId !== null ? 'ew-resize' : 'default';
      }
    };

    const onMouseUp = () => {
      if (measuringDrag) {
        measuringDrag = false;
        chart.applyOptions({ handleScroll: true, handleScale: true });
        // ドラッグ終了後も最後の計測結果を表示したまま残す（次のドラッグ開始 or モード解除まで）
        return;
      }
      if (draggingDraft !== null) {
        draggingDraft = null;
        pendingDraftPrice = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
        return;
      }
      if (draggingTarget !== null) {
        if (pendingPrice !== null) {
          const store = useTraderStore.getState();
          if (draggingTarget.kind === 'hline') store.updateLine(draggingTarget.id, { price: pendingPrice });
          else if (draggingTarget.kind === 'order') store.updateOrderPrice(draggingTarget.id, pendingPrice);
          else if (draggingTarget.kind === 'tp') store.setPositionTP(draggingTarget.id, pendingPrice);
          else if (draggingTarget.kind === 'sl') store.setPositionSL(draggingTarget.id, pendingPrice);
          else if (draggingTarget.kind === 'orderTp') store.setOrderTP(draggingTarget.id, pendingPrice);
          else store.setOrderSL(draggingTarget.id, pendingPrice);
        }
        draggingTarget = null;
        pendingPrice = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
      }
      if (draggingVId !== null) {
        if (pendingVX !== null && chartRef.current) {
          const time = chartRef.current.timeScale().coordinateToTime(pendingVX);
          if (time !== null) {
            useTraderStore.getState().updateVLine(draggingVId, { time: time as number });
          }
        }
        draggingVId = null;
        pendingVX = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
      }
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // ウィンドウリサイズ + Controls 高さ変化（ポジション増減）に追従
    const handleResize = () => {
      chart.applyOptions({
        width:  container.clientWidth,
        height: container.clientHeight,
      });
      syncVLines();
      syncWeekLines();
      updateRRPreview();
      // フロートパネルが価格軸・時間軸に被らないよう、実測サイズをストアに反映
      useTraderStore.getState().setChartMargins(
        chart.priceScale('right').width(),
        chart.timeScale().height(),
      );
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      vlineElsRef.current.forEach(el => el.remove());
      vlineElsRef.current.clear();
      weekLineElsRef.current.forEach(el => el.remove());
      weekLineElsRef.current = [];
      chart.remove();
    };
  }, []);

  // 描画・計測・価格ピッキングモード中はカーソルを crosshair に
  useEffect(() => {
    if (containerRef.current && (isDrawingLine || isDrawingVLine || isMeasuring || pickTarget !== null)) {
      containerRef.current.style.cursor = 'crosshair';
    }
  }, [isDrawingLine, isDrawingVLine, isMeasuring, pickTarget]);

  // ものさしモードを解除したら表示を消す
  useEffect(() => {
    if (!isMeasuring && measureOverlayRef.current) {
      measureOverlayRef.current.style.display = 'none';
    }
  }, [isMeasuring]);

  // 水平線の再描画（ドラッグ中の price 更新も含めて毎回フル同期）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    const existing = priceLineMapRef.current;
    const nextIds = new Set(lines.map(l => l.id));

    // 削除されたラインを除去
    for (const [id, priceLine] of existing) {
      if (!nextIds.has(id)) {
        series.removePriceLine(priceLine);
        existing.delete(id);
      }
    }

    // 追加 or 更新（既存ラインは applyOptions で in-place 更新。remove+create だとドラッグ中にカクつく）
    for (const line of lines) {
      const opts = {
        price: line.price,
        color: line.color,
        lineWidth: line.width,
        lineStyle: DASH_TO_STYLE[line.dash],
        axisLabelVisible: true,
      };
      const current = existing.get(line.id);
      if (current) {
        current.applyOptions(opts);
      } else {
        existing.set(line.id, series.createPriceLine(opts));
      }
    }
  }, [lines]);

  // 未約定注文（指値・逆指値）の価格ラインを再描画
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    const existing = orderLineMapRef.current;
    const nextIds = new Set(pendingOrders.map(o => o.id));

    for (const [id, pl] of existing) {
      if (!nextIds.has(id)) { series.removePriceLine(pl); existing.delete(id); }
    }

    for (const o of pendingOrders) {
      const opts = {
        price: o.price,
        color: o.side === 'BUY' ? '#42a5f5' : '#ab47bc',
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${o.side} ${o.type === 'limit' ? 'LIMIT' : 'STOP'}`,
      };
      const cur = existing.get(o.id);
      if (cur) cur.applyOptions(opts);
      else existing.set(o.id, series.createPriceLine(opts));
    }
  }, [pendingOrders]);

  // 未約定注文に紐づく TP / SL の価格ラインを再描画（約定前から表示）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;

    const tpExisting = orderTpLineMapRef.current;
    const withTP = pendingOrders.filter(o => o.tp !== undefined);
    const tpIds = new Set(withTP.map(o => o.id));
    for (const [id, pl] of tpExisting) {
      if (!tpIds.has(id)) { series.removePriceLine(pl); tpExisting.delete(id); }
    }
    for (const o of withTP) {
      const opts = {
        price: o.tp!,
        color: '#26a69a',
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP',
      };
      const cur = tpExisting.get(o.id);
      if (cur) cur.applyOptions(opts);
      else tpExisting.set(o.id, series.createPriceLine(opts));
    }

    const slExisting = orderSlLineMapRef.current;
    const withSL = pendingOrders.filter(o => o.sl !== undefined);
    const slIds = new Set(withSL.map(o => o.id));
    for (const [id, pl] of slExisting) {
      if (!slIds.has(id)) { series.removePriceLine(pl); slExisting.delete(id); }
    }
    for (const o of withSL) {
      const opts = {
        price: o.sl!,
        color: '#ef5350',
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL',
      };
      const cur = slExisting.get(o.id);
      if (cur) cur.applyOptions(opts);
      else slExisting.set(o.id, series.createPriceLine(opts));
    }
  }, [pendingOrders]);

  // ポジションの TP / SL 価格ラインを再描画
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;

    const tpExisting = tpLineMapRef.current;
    const withTP = positions.filter(p => p.tp !== undefined);
    const tpIds = new Set(withTP.map(p => p.id));
    for (const [id, pl] of tpExisting) {
      if (!tpIds.has(id)) { series.removePriceLine(pl); tpExisting.delete(id); }
    }
    for (const p of withTP) {
      const opts = {
        price: p.tp!,
        color: '#26a69a',
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP',
      };
      const cur = tpExisting.get(p.id);
      if (cur) cur.applyOptions(opts);
      else tpExisting.set(p.id, series.createPriceLine(opts));
    }

    const slExisting = slLineMapRef.current;
    const withSL = positions.filter(p => p.sl !== undefined);
    const slIds = new Set(withSL.map(p => p.id));
    for (const [id, pl] of slExisting) {
      if (!slIds.has(id)) { series.removePriceLine(pl); slExisting.delete(id); }
    }
    for (const p of withSL) {
      const opts = {
        price: p.sl!,
        color: '#ef5350',
        lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL',
      };
      const cur = slExisting.get(p.id);
      if (cur) cur.applyOptions(opts);
      else slExisting.set(p.id, series.createPriceLine(opts));
    }
  }, [positions]);

  // 発注パネルの draft 価格（price/TP/SL）をプレビュー表示（ドット線で確定済みと区別）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    const existing = draftLineMapRef.current;

    const wanted: { key: 'price' | 'tp' | 'sl'; price: number; color: string; title: string }[] = [];
    if (orderType !== 'market' && draftPrice !== null) {
      wanted.push({ key: 'price', price: draftPrice, color: '#888', title: '指値/逆指値 (draft)' });
    }
    if (draftTP !== null) wanted.push({ key: 'tp', price: draftTP, color: '#26a69a', title: 'TP (draft)' });
    if (draftSL !== null) wanted.push({ key: 'sl', price: draftSL, color: '#ef5350', title: 'SL (draft)' });

    const wantedKeys = new Set(wanted.map(w => w.key));
    for (const [key, pl] of existing) {
      if (!wantedKeys.has(key)) { series.removePriceLine(pl); existing.delete(key); }
    }
    for (const w of wanted) {
      const opts = {
        price: w.price,
        color: w.color,
        lineWidth: 1 as const,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: w.title,
      };
      const cur = existing.get(w.key);
      if (cur) cur.applyOptions(opts);
      else existing.set(w.key, series.createPriceLine(opts));
    }
  }, [orderType, draftPrice, draftTP, draftSL]);

  // リスクリワード（TP/SL比率）プレビューの再計算
  useEffect(() => {
    updateRRPreviewRef.current();
  }, [orderType, draftPrice, draftTP, draftSL, candles, cursor]);

  // 垂直線の再描画
  useEffect(() => {
    syncVLinesRef.current();
  }, [vlines]);

  // 価格軸の表示精度: 読み込んだペアの価格帯に合わせる（JPYクロス=小数3桁、それ以外=小数5桁）
  useEffect(() => {
    if (candles.length === 0) return;
    const precision = pricePrecision(candles[0].close);
    const minMove = 1 / 10 ** precision;
    const priceFormat = { type: 'price' as const, precision, minMove };
    seriesRef.current?.applyOptions({ priceFormat });
    emaSeriesRef.current?.applyOptions({ priceFormat });
    bbBasisSeriesRef.current?.applyOptions({ priceFormat });
    bbUpper1SeriesRef.current?.applyOptions({ priceFormat });
    bbLower1SeriesRef.current?.applyOptions({ priceFormat });
    bbUpper2SeriesRef.current?.applyOptions({ priceFormat });
    bbLower2SeriesRef.current?.applyOptions({ priceFormat });
    // 精度変更で価格軸の幅が変わるため、再描画後に実測してフロートパネルのクランプに反映
    requestAnimationFrame(() => {
      if (!chartRef.current) return;
      useTraderStore.getState().setChartMargins(
        chartRef.current.priceScale('right').width(),
        chartRef.current.timeScale().height(),
      );
    });
  }, [candles]);

  // 週区切り線: candles 変化時に境界を再計算、showWeekLines 変化時は表示トグル
  useEffect(() => {
    weekBoundariesRef.current = computeWeekBoundaries(candles);
    syncWeekLinesRef.current();
  }, [candles]);

  useEffect(() => {
    syncWeekLinesRef.current();
  }, [showWeekLines]);

  // EMA 表示 ON/OFF
  useEffect(() => {
    emaSeriesRef.current?.applyOptions({ visible: showEMA });
  }, [showEMA]);

  // ボリンジャーバンド 表示 ON/OFF（EMA同様、非表示中も裏で計算は継続しておく）
  useEffect(() => {
    bbBasisSeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper1SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower1SeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper2SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower2SeriesRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);

  // エントリー / 決済マーカー
  useEffect(() => {
    seriesRef.current?.setMarkers(buildTradeMarkers(positions, closedTrades, currencySymbol(quoteCurrency)));
  }, [positions, closedTrades, quoteCurrency]);

  // 全表示モード: 読み込んだ全データを一括表示（cursor を無視）
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0 || !showFullHistory) return;
    seriesRef.current.setData(candles.map(toBar));
    recomputeEmaFull(candles, candles.length - 1);
    recomputeBBFull(candles, candles.length - 1);
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    // fitContent 後の確定した可視範囲で再同期（範囲変更イベントに頼らず確実に揃える）
    syncVLinesRef.current();
    syncWeekLinesRef.current();
  }, [candles, showFullHistory]);

  // 画面にフィット: 現在チャートに表示されているデータ範囲をビューポートに合わせる
  useEffect(() => {
    if (fitSignal === 0 || !chartRef.current) return;
    chartRef.current.timeScale().fitContent();
  }, [fitSignal]);

  // リプレイモード: カーソル変化時にデータ更新（ローソク足 + EMA200）
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0 || showFullHistory) return;

    const isStep =
      candles === prevCandlesRef.current &&
      cursor === prevCursorRef.current + 1;

    if (isStep) {
      seriesRef.current.update(toBar(candles[cursor]));
      updateEmaStep(candles[cursor]);
      updateBBStep(candles, cursor);
    } else {
      seriesRef.current.setData(candles.slice(0, cursor + 1).map(toBar));
      chartRef.current?.timeScale().scrollToRealTime();
      recomputeEmaFull(candles, cursor);
      recomputeBBFull(candles, cursor);
    }
    // 価格軸ドラッグ等で autoScale が無効化されたままだと、再生中にローソク足が
    // 上下にはみ出ても追従しなくなる。毎ステップ明示的に再有効化して縦も自動追従させる
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    // 可視範囲確定後に再同期（範囲変更イベントに頼らず確実に揃える）
    syncVLinesRef.current();
    syncWeekLinesRef.current();

    prevCursorRef.current  = cursor;
    prevCandlesRef.current = candles;
  }, [candles, cursor, showFullHistory]);

  // 指定時刻を中心に表示（縮尺=現在の可視範囲の幅は維持したまま移動）
  // リプレイモード側の setData/scrollToRealTime より後に実行し、最終的な表示位置を確定させる
  useEffect(() => {
    if (centerSignal === 0 || !chartRef.current) return;
    const range = chartRef.current.timeScale().getVisibleRange();
    if (!range) return;
    const span = (range.to as number) - (range.from as number);
    const half = span / 2;
    chartRef.current.timeScale().setVisibleRange({
      from: (centerTarget - half) as Time,
      to: (centerTarget + half) as Time,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerSignal]);

  function recomputeEmaFull(cs: Candle[], uptoIndex: number) {
    const k = 2 / (EMA_PERIOD + 1);
    let sum = 0;
    let ema = 0;
    const data: LineData[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
      const close = cs[i].close;
      if (i < EMA_PERIOD - 1) {
        sum += close;
        continue;
      }
      if (i === EMA_PERIOD - 1) {
        sum += close;
        ema = sum / EMA_PERIOD;
      } else {
        ema = close * k + ema * (1 - k);
      }
      data.push({ time: cs[i].time as Time, value: ema });
    }
    emaSeriesRef.current?.setData(data);
    emaValueRef.current = ema;
    emaSumRef.current = sum;
    emaCountRef.current = uptoIndex + 1;
  }

  function updateEmaStep(newCandle: Candle) {
    const k = 2 / (EMA_PERIOD + 1);
    const count = emaCountRef.current + 1;
    emaCountRef.current = count;

    if (count < EMA_PERIOD) {
      emaSumRef.current += newCandle.close;
      return;
    }
    if (count === EMA_PERIOD) {
      emaSumRef.current += newCandle.close;
      emaValueRef.current = emaSumRef.current / EMA_PERIOD;
    } else {
      emaValueRef.current = newCandle.close * k + emaValueRef.current * (1 - k);
    }
    emaSeriesRef.current?.update({ time: newCandle.time as Time, value: emaValueRef.current });
  }

  // ボリンジャーバンド: 移動窓(BB_PERIOD)の合計・二乗和から SMA と標準偏差を算出（±1σ・±2σ）
  function recomputeBBFull(cs: Candle[], uptoIndex: number) {
    const basisData: LineData[] = [];
    const upper1Data: LineData[] = [];
    const lower1Data: LineData[] = [];
    const upper2Data: LineData[] = [];
    const lower2Data: LineData[] = [];
    let sum = 0, sumSq = 0;
    for (let i = 0; i <= uptoIndex; i++) {
      const close = cs[i].close;
      sum += close;
      sumSq += close * close;
      if (i >= BB_PERIOD) {
        const old = cs[i - BB_PERIOD].close;
        sum -= old;
        sumSq -= old * old;
      }
      if (i >= BB_PERIOD - 1) {
        const mean = sum / BB_PERIOD;
        const sd = Math.sqrt(Math.max(sumSq / BB_PERIOD - mean * mean, 0));
        const time = cs[i].time as Time;
        basisData.push({ time, value: mean });
        upper1Data.push({ time, value: mean + sd });
        lower1Data.push({ time, value: mean - sd });
        upper2Data.push({ time, value: mean + 2 * sd });
        lower2Data.push({ time, value: mean - 2 * sd });
      }
    }
    bbBasisSeriesRef.current?.setData(basisData);
    bbUpper1SeriesRef.current?.setData(upper1Data);
    bbLower1SeriesRef.current?.setData(lower1Data);
    bbUpper2SeriesRef.current?.setData(upper2Data);
    bbLower2SeriesRef.current?.setData(lower2Data);
    bbSumRef.current = sum;
    bbSumSqRef.current = sumSq;
  }

  function updateBBStep(cs: Candle[], idx: number) {
    const close = cs[idx].close;
    bbSumRef.current += close;
    bbSumSqRef.current += close * close;
    if (idx >= BB_PERIOD) {
      const old = cs[idx - BB_PERIOD].close;
      bbSumRef.current -= old;
      bbSumSqRef.current -= old * old;
    }
    if (idx < BB_PERIOD - 1) return;
    const mean = bbSumRef.current / BB_PERIOD;
    const sd = Math.sqrt(Math.max(bbSumSqRef.current / BB_PERIOD - mean * mean, 0));
    const time = cs[idx].time as Time;
    bbBasisSeriesRef.current?.update({ time, value: mean });
    bbUpper1SeriesRef.current?.update({ time, value: mean + sd });
    bbLower1SeriesRef.current?.update({ time, value: mean - sd });
    bbUpper2SeriesRef.current?.update({ time, value: mean + 2 * sd });
    bbLower2SeriesRef.current?.update({ time, value: mean - 2 * sd });
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={weekOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 10 }} />
      <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 11 }} />
      <div ref={measureOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 12, display: 'none' }}>
        <div ref={measureBoxRef} style={{ position: 'absolute' }} />
        <div ref={measureMidLineRef} style={{ position: 'absolute', width: '0px' }} />
        <div ref={measureLabelRef} style={{
          position: 'absolute', backgroundColor: '#1a1a1a', border: '1px solid #333',
          borderRadius: '4px', padding: '6px 10px', whiteSpace: 'nowrap',
        }} />
      </div>
      <div ref={rrOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 13, display: 'none' }}>
        <div ref={rrTpBoxRef} style={{ position: 'absolute', backgroundColor: 'rgba(38,166,154,0.15)', border: '1px solid #26a69a', display: 'none' }} />
        <div ref={rrSlBoxRef} style={{ position: 'absolute', backgroundColor: 'rgba(239,83,80,0.15)', border: '1px solid #ef5350', display: 'none' }} />
        <div ref={rrLabelRef} style={{
          position: 'absolute', color: '#ccc', fontSize: '13px', fontWeight: 700,
          backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '4px',
          padding: '3px 8px', whiteSpace: 'nowrap', display: 'none',
        }} />
      </div>
    </div>
  );
}
