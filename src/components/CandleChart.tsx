import { useEffect, useRef } from 'react';
import {
  createChart, LineStyle, CrosshairMode,
  type IChartApi, type ISeriesApi, type CandlestickSeriesOptions,
  type Time, type UTCTimestamp, type CandlestickData, type LineData, type IPriceLine,
  type SeriesMarker,
} from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { Candle, Position, ClosedTrade, LineSelection } from '../types';
import { TIMEFRAMES } from '../types';
import { currencySymbol } from '../lib/currency';
import { inferPipSize, pricePrecision } from '../lib/pips';
import { CHART_FONT_FAMILY, CHART_AXIS_TEXT_COLOR, CHART_AXIS_FONT_SIZE, DASH_TO_STYLE, DASH_TO_CSS } from '../lib/chartTheme';
import { ChartHeader } from './ChartHeader';
import { loadChartView, saveChartView, relativeViewToLogicalRange } from '../lib/chartViewState';
import { computeSeparatorBoundaries } from '../lib/weekLines';
import { cloudDisplacedTime } from '../lib/indicators';
import { priceAtTime } from '../lib/crosshairSync';
import { logError } from '../lib/errorLog';

// 水平方向にドラッグ可能な対象（水平線 / 未約定注文 / TP / SL）
type DragTarget =
  | { kind: 'hline'; id: number }
  | { kind: 'order'; id: number }
  | { kind: 'tp'; id: number }
  | { kind: 'sl'; id: number }
  | { kind: 'orderTp'; id: number }
  | { kind: 'orderSl'; id: number };

// 四角形のドラッグ中の角。timeField/priceFieldは「動かす方の角が持つフィールド名」
// （反対側の角は固定したまま、この2フィールドだけ更新してリサイズする）
interface RectCorner {
  rectId: number;
  timeField: 'time1' | 'time2';
  priceField: 'price1' | 'price2';
}

// 四角形のドラッグ中の辺（4隅の中間点）。1フィールドだけ更新して上下/左右いずれか一方向にリサイズする
interface RectEdge {
  rectId: number;
  field: 'time1' | 'time2' | 'price1' | 'price2';
}

const EMA_PERIOD = 200;
const SMA_PERIOD = 14;
const BB_PERIOD = 20;
const DRAG_TOLERANCE_PX = 6;
const MIN_JUMP_SPAN_BARS = 30; // 日時ジャンプ時、表示幅がこの本数分未満にはならないようにする

// 一目均衡表「雲」（先行スパンA/B）
const TENKAN_PERIOD = 9;
const KIJUN_PERIOD = 26;
const SENKOU_B_PERIOD = 52;

const toBar = (c: Candle): CandlestickData => ({
  time: c.time as Time,
  open: c.open, high: c.high, low: c.low, close: c.close,
});

// 直近 period 本（idx を含む）の高値・安値
function highLowWindow(cs: Candle[], idx: number, period: number): { hi: number; lo: number } {
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, idx - period + 1); j <= idx; j++) {
    if (cs[j].high > hi) hi = cs[j].high;
    if (cs[j].low  < lo) lo = cs[j].low;
  }
  return { hi, lo };
}

// 一目均衡表の先行スパンA/B（過去データのみから算出、idx 時点で必要本数が揃っていなければ null）
function computeCloudPoint(cs: Candle[], idx: number): { a: number; b: number } | null {
  if (idx < SENKOU_B_PERIOD - 1) return null;
  const tenkanW  = highLowWindow(cs, idx, TENKAN_PERIOD);
  const kijunW   = highLowWindow(cs, idx, KIJUN_PERIOD);
  const senkouBW = highLowWindow(cs, idx, SENKOU_B_PERIOD);
  const tenkan = (tenkanW.hi + tenkanW.lo) / 2;
  const kijun  = (kijunW.hi + kijunW.lo) / 2;
  return { a: (tenkan + kijun) / 2, b: (senkouBW.hi + senkouBW.lo) / 2 };
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
  const syncCloudRef = useRef<() => void>(() => {});
  const priceLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const tpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const slLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderTpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderSlLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const draftLineMapRef = useRef<Map<'price' | 'tp' | 'sl', IPriceLine>>(new Map());
  const vlineElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const lineHandleElRef = useRef<HTMLDivElement | null>(null); // 選択中の水平線/垂直線の中点ハンドル（常に1個分のみ）
  const syncVLinesRef = useRef<() => void>(() => {});
  const rectOverlayRef = useRef<HTMLDivElement>(null);
  const rectElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const rectHandleElsRef = useRef<HTMLDivElement[]>([]); // 選択中の四角形の4隅ハンドル（常に1個の四角形分のみ）
  const syncRectsRef = useRef<() => void>(() => {});
  const rectDraftBoxRef = useRef<HTMLDivElement>(null);
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
  const scrubberTrackRef = useRef<HTMLDivElement>(null);
  const scrubberThumbRef = useRef<HTMLDivElement>(null);
  const syncScrubberRef = useRef<() => void>(() => {});

  const candles = useTraderStore(s => s.candles);
  const cursor    = useTraderStore(s => s.cursor);
  const positions = useTraderStore(s => s.positions);
  const pendingOrders = useTraderStore(s => s.pendingOrders);
  const closedTrades = useTraderStore(s => s.closedTrades);
  const quoteCurrency = useTraderStore(s => s.quoteCurrency);
  const symbol = useTraderStore(s => s.symbol);
  const lines     = useTraderStore(s => s.lines);
  const vlines    = useTraderStore(s => s.vlines);
  const rects     = useTraderStore(s => s.rects);
  const selected  = useTraderStore(s => s.selected);
  const isDrawingLine  = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring    = useTraderStore(s => s.isMeasuring);
  const isDrawingRect  = useTraderStore(s => s.isDrawingRect);
  const pickTarget     = useTraderStore(s => s.pickTarget);
  const orderType      = useTraderStore(s => s.orderType);
  const draftPrice     = useTraderStore(s => s.draftPrice);
  const draftTP        = useTraderStore(s => s.draftTP);
  const draftSL        = useTraderStore(s => s.draftSL);
  const showEMA   = useTraderStore(s => s.showEMA);
  const showSMA   = useTraderStore(s => s.showSMA);
  const showBB    = useTraderStore(s => s.showBB);
  const showCloud = useTraderStore(s => s.showCloud);
  const timeframeSec = useTraderStore(s => s.timeframeSec);
  const setTimeframe = useTraderStore(s => s.setTimeframe);
  const isLoaded = useTraderStore(s => s.isLoaded);
  const dataVersion = useTraderStore(s => s.dataVersion);
  const showWeekLines = useTraderStore(s => s.showWeekLines);
  const fitSignal  = useTraderStore(s => s.fitSignal);
  const scrollToLatestSignal = useTraderStore(s => s.scrollToLatestSignal);
  const centerSignal = useTraderStore(s => s.centerSignal);
  const centerTarget = useTraderStore(s => s.centerTarget);
  const crosshairSourceId = useTraderStore(s => s.crosshairSourceId);
  const crosshairTime = useTraderStore(s => s.crosshairTime);
  const chartRightMargin = useTraderStore(s => s.chartRightMargin);
  const chartBottomMargin = useTraderStore(s => s.chartBottomMargin);
  const timeframeLabel = TIMEFRAMES.find(tf => tf.sec === timeframeSec)?.label ?? '';

  const prevCursorRef  = useRef(-1);
  const prevCandlesRef = useRef<Candle[]>([]);
  const restoredViewKeyRef = useRef<string | null>(null);
  const saveViewTimerRef = useRef<number | undefined>(undefined);

  // EMA 増分計算用の状態
  const emaValueRef = useRef(0);
  const emaSumRef   = useRef(0);
  const emaCountRef = useRef(0);

  // SMA14（単純移動平均・移動窓の合計を差分更新）
  const smaSumRef = useRef(0);

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
        textColor: CHART_AXIS_TEXT_COLOR,
        fontSize: CHART_AXIS_FONT_SIZE,
        fontFamily: CHART_FONT_FAMILY,
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a' },
      },
      // Magnet（デフォルト）は足の実データ点にしか吸着せず、ローソク足やインジケーターの
      // 無い空白部分（価格レンジの外・右側の余白等）ではカーソルが出ない。Normalにすると
      // マウス位置にそのまま追従し、何もない場所でも十字カーソルを出せる
      crosshair: {
        mode: CrosshairMode.Normal,
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
    const smaSeries = chart.addLineSeries({
      color: '#ab47bc',
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
    const cloudLineOptions = {
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
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

    // 4画面時、実マウス操作で動いた十字カーソルの時刻を他パネルへ共有する。
    // sourceEvent が無い場合は setCrosshairPosition による同期側からの発火なので無視する（無限ループ防止）
    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = param => {
      if (!param.sourceEvent) return;
      useTraderStore.getState().setCrosshair('main', (param.time as number | undefined) ?? null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    // ── 雲（先行スパンA/B）の塗りつぶしを canvas に再描画 ────────────────
    const syncCloud = () => {
      const canvas = cloudCanvasRef.current;
      if (!canvas || !chartRef.current || !seriesRef.current) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      const { showCloud: show, candles: cs } = useTraderStore.getState();
      const points = cloudDataRef.current;
      if (!show || points.length < 2) return;

      const timeScale = chartRef.current.timeScale();
      const series = seriesRef.current;
      // 表示範囲がローソク足の実データより外側に及んでいても、雲は最初の足より左側には描画しない
      // （timeToCoordinate は範囲外の時刻も外挿してしまうため）
      const leftBoundX = cs.length > 0 ? timeScale.timeToCoordinate(cs[0].time as Time) : null;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i], p1 = points[i + 1];
        const x0 = timeScale.timeToCoordinate(p0.time as Time);
        const x1 = timeScale.timeToCoordinate(p1.time as Time);
        if (x0 === null || x1 === null) continue;
        if (leftBoundX !== null && x1 <= leftBoundX) continue;
        const ya0 = series.priceToCoordinate(p0.a);
        const ya1 = series.priceToCoordinate(p1.a);
        const yb0 = series.priceToCoordinate(p0.b);
        const yb1 = series.priceToCoordinate(p1.b);
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

    // 時刻→X座標変換。timeToCoordinateは足の時刻と完全一致しないとnullを返すため、
    // 時間軸切替（例: 15m→4H）で描画済みの水平線/四角形の時刻が新しい足のグリッドと
    // 一致せず、見えなくなってしまう問題への対策。表示範囲内なら前後の実足の座標を
    // 線形補間し、範囲外なら最初/最後の足にクランプする
    const timeToX = (t: number): number | null => {
      if (!chartRef.current) return null;
      const ts = chartRef.current.timeScale();
      const exact = ts.timeToCoordinate(t as Time);
      if (exact !== null) return exact;
      const { candles: cs, cursor } = useTraderStore.getState();
      const visible = cs.slice(0, cursor + 1);
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

    // ── 垂直線の位置を再計算して DOM に反映 ────────────────────────
    const syncVLines = () => {
      if (!chartRef.current || !overlayRef.current || !seriesRef.current) return;
      const { vlines: currentVLines, lines: currentLines, selected } = useTraderStore.getState();
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
        const x = timeToX(v.time);
        if (x === null) {
          el.style.display = 'none';
        } else {
          el.style.display = 'block';
          el.style.left = `${x}px`;
          el.style.borderLeft = `${v.width}px ${DASH_TO_CSS[v.dash]} ${v.color}`;
        }
      }

      // 選択中の水平線・垂直線があれば中点にハンドルを1つ表示する（編集モードの目印。
      // 実際の移動は既存のドラッグ判定（findPriceTargetNear/findVLineNear）が
      // 線全体のどこでも受け付けるので、ハンドルは見た目上のマーカーを兼ねる）
      let handle = lineHandleElRef.current;
      if (!handle) {
        handle = document.createElement('div');
        handle.style.position = 'absolute';
        handle.style.width = '8px';
        handle.style.height = '8px';
        handle.style.backgroundColor = '#42a5f5';
        handle.style.border = '1px solid #fff';
        handle.style.borderRadius = '2px';
        handle.style.pointerEvents = 'none';
        handle.style.display = 'none';
        overlay.appendChild(handle);
        lineHandleElRef.current = handle;
      }
      let point: [number, number] | null = null;
      if (selected?.kind === 'h') {
        const line = currentLines.find(l => l.id === selected.id);
        const y = line ? seriesRef.current.priceToCoordinate(line.price) : null;
        if (y !== null) point = [container.clientWidth / 2, y];
      } else if (selected?.kind === 'v') {
        const v = currentVLines.find(vv => vv.id === selected.id);
        const x = v ? timeToX(v.time) : null;
        if (x !== null) point = [x, container.clientHeight / 2];
      }
      if (point) {
        handle.style.display = 'block';
        handle.style.left = `${point[0] - 4}px`;
        handle.style.top = `${point[1] - 4}px`;
      } else {
        handle.style.display = 'none';
      }
    };
    syncVLinesRef.current = syncVLines;
    syncVLines();

    // ── 四角形の位置を再計算して DOM に反映（枠線のみ、選択中は破線＋4隅・4辺のハンドル） ──
    const RECT_HANDLE_SIZE = 8;
    // 4隅+4辺の中点にハンドルを配置する（0-3=4隅、4-7=上/下/左/右の中点）。
    // syncRects（store確定後）だけでなく、コーナー/辺ドラッグ中のrAFプレビューからも
    // 同じフレームで呼ぶことで、ドラッグ中に本体だけ動いてハンドルが取り残されるのを防ぐ
    const positionRectHandles = (x1: number, x2: number, y1: number, y2: number) => {
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
      const points: [number, number][] = [
        [x1, y1], [x1, y2], [x2, y1], [x2, y2],
        [midX, Math.min(y1, y2)], [midX, Math.max(y1, y2)],
        [Math.min(x1, x2), midY], [Math.max(x1, x2), midY],
      ];
      points.forEach(([cx, cy], i) => {
        const h = rectHandleElsRef.current[i];
        if (!h) return;
        h.style.display = 'block';
        h.style.left = `${cx - RECT_HANDLE_SIZE / 2}px`;
        h.style.top = `${cy - RECT_HANDLE_SIZE / 2}px`;
      });
    };
    const syncRects = () => {
      if (!chartRef.current || !seriesRef.current || !rectOverlayRef.current) return;
      const { rects: currentRects, selected } = useTraderStore.getState();
      const overlay = rectOverlayRef.current;
      const existing = rectElsRef.current;
      const nextIds = new Set(currentRects.map(r => r.id));
      const selectedRectId = selected?.kind === 'rect' ? selected.id : null;

      for (const [id, el] of existing) {
        if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
      }

      // ハンドルは選択中の四角形1つぶんだけ使い回す（毎回作り直さない）。
      // 0-3=4隅、4-7=4辺の中点（上・下・左・右）
      const handles = rectHandleElsRef.current;
      while (handles.length < 8) {
        const h = document.createElement('div');
        h.style.position = 'absolute';
        h.style.width = `${RECT_HANDLE_SIZE}px`;
        h.style.height = `${RECT_HANDLE_SIZE}px`;
        h.style.backgroundColor = '#42a5f5';
        h.style.border = '1px solid #fff';
        h.style.borderRadius = '2px';
        h.style.pointerEvents = 'none';
        h.style.display = 'none';
        overlay.appendChild(h);
        handles.push(h);
      }

      let hasSelected = false;

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
        const isSelected = r.id === selectedRectId;
        // 選択中でも線種は変えない（水平線・垂直線と同様、編集モードの目印はハンドルだけで示す）
        el.style.border = `${r.width}px ${DASH_TO_CSS[r.dash]} ${r.color}`;
        if (isSelected) {
          hasSelected = true;
          positionRectHandles(x1, x2, y1, y2);
        }
      }

      if (!hasSelected) {
        handles.forEach(h => { h.style.display = 'none'; });
      }
    };
    syncRectsRef.current = syncRects;
    syncRects();

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

    // ── 全期間スクラバー（YouTubeのシークバーのように、全体に対する現在の表示位置・
    // 幅をバーで示し、ドラッグで平行移動・クリックでジャンプできるようにする） ──────
    const getScrubberTotalBars = () => {
      const { cursor: cur } = useTraderStore.getState();
      return cur + 1;
    };
    const syncScrubber = () => {
      if (!chartRef.current || !scrubberTrackRef.current || !scrubberThumbRef.current) return;
      const totalBars = getScrubberTotalBars();
      const range = chartRef.current.timeScale().getVisibleLogicalRange();
      const trackWidth = scrubberTrackRef.current.clientWidth;
      if (totalBars <= 0 || !range || trackWidth <= 0) {
        scrubberThumbRef.current.style.display = 'none';
        return;
      }
      const from = Math.max(0, range.from);
      const to = Math.min(totalBars, range.to);
      scrubberThumbRef.current.style.display = 'block';
      scrubberThumbRef.current.style.left = `${(from / totalBars) * trackWidth}px`;
      scrubberThumbRef.current.style.width = `${Math.max(4, ((to - from) / totalBars) * trackWidth)}px`;
    };
    syncScrubberRef.current = syncScrubber;
    syncScrubber();

    // つまみを掴んだら平行移動、余白をクリックしたらそこを中心にジャンプ（幅＝ズームは変えない）
    let scrubbing = false;
    let scrubStartX = 0;
    let scrubStartRange: { from: number; to: number } | null = null;

    const onScrubberDown = (e: MouseEvent) => {
      if (!chartRef.current || !scrubberTrackRef.current) return;
      const trackRect = scrubberTrackRef.current.getBoundingClientRect();
      const x = e.clientX - trackRect.left;
      const totalBars = getScrubberTotalBars();
      const range = chartRef.current.timeScale().getVisibleLogicalRange();
      if (totalBars <= 0 || !range || trackRect.width <= 0) return;
      const span = range.to - range.from;
      const thumbLeftPx = (Math.max(0, range.from) / totalBars) * trackRect.width;
      const thumbRightPx = (Math.min(totalBars, range.to) / totalBars) * trackRect.width;
      let from: number = range.from;
      let to: number = range.to;
      if (x < thumbLeftPx || x > thumbRightPx) {
        // トラックの余白クリック: そこを中心に瞬時にジャンプしてから、そのままドラッグ継続できる
        const clickBar = (x / trackRect.width) * totalBars;
        from = clickBar - span / 2;
        to = clickBar + span / 2;
        chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
      }
      scrubbing = true;
      scrubStartX = x;
      scrubStartRange = { from, to };
      e.preventDefault();
    };

    const onScrubberMove = (e: MouseEvent) => {
      if (!scrubbing || !scrubStartRange || !chartRef.current || !scrubberTrackRef.current) return;
      const trackRect = scrubberTrackRef.current.getBoundingClientRect();
      if (trackRect.width <= 0) return;
      const x = e.clientX - trackRect.left;
      const totalBars = getScrubberTotalBars();
      if (totalBars <= 0) return;
      const span = scrubStartRange.to - scrubStartRange.from;
      const dxBars = ((x - scrubStartX) / trackRect.width) * totalBars;
      let from = scrubStartRange.from + dxBars;
      let to = scrubStartRange.to + dxBars;
      if (from < 0) { from = 0; to = span; }
      if (to > totalBars) { to = totalBars; from = totalBars - span; }
      chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
    };

    const onScrubberUp = () => {
      scrubbing = false;
      scrubStartRange = null;
      if (!hoveringScrubber && scrubberTrackRef.current) scrubberTrackRef.current.style.opacity = '0.2';
    };

    // 普段は薄く、マウスを近づけた時とドラッグ中だけはっきり表示する。
    // ドラッグ中にカーソルがバーの外へ出ても（youtube等と同じく）薄くしない
    let hoveringScrubber = false;
    const onScrubberEnter = () => {
      hoveringScrubber = true;
      if (scrubberTrackRef.current) scrubberTrackRef.current.style.opacity = '1';
    };
    const onScrubberLeave = () => {
      hoveringScrubber = false;
      if (!scrubbing && scrubberTrackRef.current) scrubberTrackRef.current.style.opacity = '0.2';
    };

    scrubberTrackRef.current?.addEventListener('mousedown', onScrubberDown);
    scrubberTrackRef.current?.addEventListener('mouseenter', onScrubberEnter);
    scrubberTrackRef.current?.addEventListener('mouseleave', onScrubberLeave);
    window.addEventListener('mousemove', onScrubberMove);
    window.addEventListener('mouseup', onScrubberUp);

    // 表示中のズーム/スケールを時間軸ごとに記憶（連続発火するため軽くデバウンス）
    const scheduleSaveView = () => {
      if (saveViewTimerRef.current !== undefined) window.clearTimeout(saveViewTimerRef.current);
      saveViewTimerRef.current = window.setTimeout(() => {
        if (!chartRef.current) return;
        const range = chartRef.current.timeScale().getVisibleLogicalRange();
        if (!range) return;
        const { cursor: cur, timeframeSec: tf } = useTraderStore.getState();
        const totalBars = cur + 1;
        if (totalBars <= 0) return;
        saveChartView(tf, { span: range.to - range.from, barsFromRight: totalBars - range.to });
      }, 400);
    };

    const onRangeChange = () => { syncVLines(); syncRects(); syncWeekLines(); updateRRPreview(); syncCloud(); syncScrubber(); scheduleSaveView(); };
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
        const snap = magnetSnap(param.point.x, param.point.y);
        if (snap !== null) addLine(snap.price);
        return;
      }
      if (drawingV && chartRef.current) {
        const time = chartRef.current.timeScale().coordinateToTime(param.point.x);
        if (time !== null) addVLine(time as number);
      }
    });

    // ── 四角形（ドラッグで描画） ──────────────────────────────────
    let rectDragging = false;
    let rectStart: { x: number; y: number; price: number } | null = null;
    let pendingRectEnd: { x: number; y: number; price: number } | null = null;

    const updateRectDraftBox = (x1: number, y1: number, x2: number, y2: number) => {
      const box = rectDraftBoxRef.current;
      if (!box) return;
      const { rectDraft } = useTraderStore.getState();
      box.style.display = 'block';
      box.style.left = `${Math.min(x1, x2)}px`;
      box.style.top = `${Math.min(y1, y2)}px`;
      box.style.width = `${Math.abs(x2 - x1)}px`;
      box.style.height = `${Math.abs(y2 - y1)}px`;
      box.style.border = `${rectDraft.width}px ${DASH_TO_CSS[rectDraft.dash]} ${rectDraft.color}`;
    };

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
    let draggingRectCorner: RectCorner | null = null;
    let draggingRectEdge: RectEdge | null = null;
    let pendingPrice: number | null = null;
    let pendingVX: number | null = null;
    let pendingDraftPrice: number | null = null;
    let pendingRectCornerPos: { time: number; price: number } | null = null;
    let pendingRectEdgeValue: number | null = null;
    let rafScheduled = false;
    // 価格軸のドラッグによる縦スケール変更はlightweight-charts側の内部処理で、
    // それを教えてくれるイベントが無い。そのためドラッグ操作中でなくても、マウスが
    // 動くたびに（rAFで間引きながら）垂直線・四角形・区切り線・雲を再計算することで
    // 追従させる（本来の座標変換はスケールに依存するので、再計算自体は毎回必要な処理）
    let overlayResyncScheduled = false;

    // ── 四角形の枠（ハンドル以外の辺）をつかんでの平行移動 ──────────────
    // リサイズ（角・辺の中点）と違い、4隅すべてに同じ時間・価格の差分を
    // 加算するだけ。掴んだ瞬間の位置を基準に差分を測るので、枠のどこを
    // つかんでも（中点でなくても）ズレなく平行移動する
    let draggingRectMoveId: number | null = null;
    // 時間方向の移動は秒数の差分ではなく足のインデックスの差分で行う（雲の先行スパンと同じ理由）。
    // 週末や休場日で足が抜けている区間をまたぐと、同じ秒数でも実際の足の本数は場所によって
    // 変わるため、四角形の両端に同じ「秒数」を足すと片方だけ足の本数がズレて幅が変わってしまう
    let rectMoveStart: { idx1: number; idx2: number; price1: number; price2: number; startIdx: number; startPrice: number } | null = null;
    let pendingRectMoveDelta: { idx: number; dp: number } | null = null;

    // ── コピー&ペースト（Cmd/Ctrl+C / Cmd/Ctrl+V） ──────────────────────
    // クリップボードはこのコンポーネントの寿命内だけ有効なローカル変数
    // （storeに持たせるとリロード後まで残ってしまい、選択解除と挙動が食い違うため）。
    // ペースト後はクリップボードを複製先に差し替える。連続でVを押すと
    // その都度OFFSET_PXずつ右下へずれながら複製されていく（斜めに並ぶ）
    let clipboard: LineSelection | null = null;
    const PASTE_OFFSET_PX = 20;

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
        const vx = timeToX(v.time);
        if (vx !== null && Math.abs(vx - x) <= DRAG_TOLERANCE_PX) return v.id;
      }
      return null;
    };

    // 四角形の4つの角のいずれかの近くか判定（リサイズハンドル）
    const findRectCornerNear = (x: number, y: number): RectCorner | null => {
      if (!chartRef.current || !seriesRef.current) return null;
      const { rects: currentRects, selected } = useTraderStore.getState();
      // ハンドル（角の小さな四角）は選択中の四角形にしか表示されないため、判定も選択中のものだけに
      // 限定する。そうしないと未選択の四角形の辺のちょうど中央あたりを「枠を掴んで移動」しようとした
      // 際に、見えないハンドルに引っかかって意図せずリサイズされてしまう
      for (const r of currentRects.filter(rr => selected?.kind === 'rect' && selected.id === rr.id)) {
        const x1 = timeToX(r.time1);
        const x2 = timeToX(r.time2);
        const y1 = seriesRef.current.priceToCoordinate(r.price1);
        const y2 = seriesRef.current.priceToCoordinate(r.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const corners: [number, number, RectCorner['timeField'], RectCorner['priceField']][] = [
          [x1, y1, 'time1', 'price1'],
          [x1, y2, 'time1', 'price2'],
          [x2, y1, 'time2', 'price1'],
          [x2, y2, 'time2', 'price2'],
        ];
        for (const [cx, cy, timeField, priceField] of corners) {
          if (Math.hypot(cx - x, cy - y) <= DRAG_TOLERANCE_PX) {
            return { rectId: r.id, timeField, priceField };
          }
        }
      }
      return null;
    };

    // 四角形の4辺の中点のいずれかの近くか判定（上下または左右いずれか一方向だけのリサイズ）。
    // 「上辺」「左辺」等は画面上の位置（min/max）で決めるが、実際に更新するフィールドは
    // time1/time2・price1/price2 のうち掴んだ瞬間にその位置にあった方1つに固定する
    // （四角形の中身をドラッグで反転させても、その後は同じフィールドを更新し続ける。角のドラッグと同じ考え方）
    const findRectEdgeNear = (x: number, y: number): RectEdge | null => {
      if (!chartRef.current || !seriesRef.current) return null;
      const { rects: currentRects, selected } = useTraderStore.getState();
      // 角のハンドルと同じ理由で、選択中の四角形の辺だけを対象にする
      for (const r of currentRects.filter(rr => selected?.kind === 'rect' && selected.id === rr.id)) {
        const x1 = timeToX(r.time1);
        const x2 = timeToX(r.time2);
        const y1 = seriesRef.current.priceToCoordinate(r.price1);
        const y2 = seriesRef.current.priceToCoordinate(r.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
        const topField: RectEdge['field'] = y1 <= y2 ? 'price1' : 'price2';
        const bottomField: RectEdge['field'] = y1 <= y2 ? 'price2' : 'price1';
        const leftField: RectEdge['field'] = x1 <= x2 ? 'time1' : 'time2';
        const rightField: RectEdge['field'] = x1 <= x2 ? 'time2' : 'time1';
        const edges: [number, number, RectEdge['field']][] = [
          [midX, Math.min(y1, y2), topField],
          [midX, Math.max(y1, y2), bottomField],
          [Math.min(x1, x2), midY, leftField],
          [Math.max(x1, x2), midY, rightField],
        ];
        for (const [ex, ey, field] of edges) {
          if (Math.hypot(ex - x, ey - y) <= DRAG_TOLERANCE_PX) {
            return { rectId: r.id, field };
          }
        }
      }
      return null;
    };

    // 四角形の枠内（境界も少し外側まで許容）をクリックしたか判定。ヒットしたら選択状態にする
    // （見た目上の編集モードに入り、破線枠＋4隅ハンドルが出る）。ここでは選択するだけで、
    // ドラッグでの本体移動は対応しない（対応するのは4隅のリサイズのみ）
    // 四角形の枠線上（角・辺の中点ハンドルは含まない、辺全体）を掴んだかどうかの判定。
    // mousedownではfindRectCornerNear/findRectEdgeNearの後に呼ぶことで、ハンドル上の
    // クリックは常にリサイズが優先され、それ以外の枠線上のクリックだけが平行移動になる
    const findRectBorderNear = (x: number, y: number): number | null => {
      if (!chartRef.current || !seriesRef.current) return null;
      const { rects: currentRects } = useTraderStore.getState();
      for (const r of currentRects) {
        const x1 = timeToX(r.time1);
        const x2 = timeToX(r.time2);
        const y1 = seriesRef.current.priceToCoordinate(r.price1);
        const y2 = seriesRef.current.priceToCoordinate(r.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        const withinX = x >= left - DRAG_TOLERANCE_PX && x <= right + DRAG_TOLERANCE_PX;
        const withinY = y >= top - DRAG_TOLERANCE_PX && y <= bottom + DRAG_TOLERANCE_PX;
        const nearVerticalEdge   = withinY && (Math.abs(x - left) <= DRAG_TOLERANCE_PX || Math.abs(x - right) <= DRAG_TOLERANCE_PX);
        const nearHorizontalEdge = withinX && (Math.abs(y - top) <= DRAG_TOLERANCE_PX || Math.abs(y - bottom) <= DRAG_TOLERANCE_PX);
        if (nearVerticalEdge || nearHorizontalEdge) return r.id;
      }
      return null;
    };

    const findRectBodyNear = (x: number, y: number): number | null => {
      if (!chartRef.current || !seriesRef.current) return null;
      const { rects: currentRects } = useTraderStore.getState();
      for (const r of currentRects) {
        const x1 = timeToX(r.time1);
        const x2 = timeToX(r.time2);
        const y1 = seriesRef.current.priceToCoordinate(r.price1);
        const y2 = seriesRef.current.priceToCoordinate(r.price2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        const left = Math.min(x1, x2) - DRAG_TOLERANCE_PX, right = Math.max(x1, x2) + DRAG_TOLERANCE_PX;
        const top = Math.min(y1, y2) - DRAG_TOLERANCE_PX, bottom = Math.max(y1, y2) + DRAG_TOLERANCE_PX;
        if (x >= left && x <= right && y >= top && y <= bottom) return r.id;
      }
      return null;
    };

    // 四角形の頂点のX座標→時刻変換。lightweight-chartsのcoordinateToTimeをそのまま使う
    // （足に吸着する＝ドラッグ幅が1本未満だと細くなるが、それ自体は仕様として許容する）。
    // 唯一のクランプは「実際に表示されている足（リプレイ中ならcursorまで）の範囲より外側は
    // nullが返る」ケースだけで、その場合は表示中の最初/最後の足の時刻に丸める
    const pixelToTime = (x: number): number | null => {
      if (!chartRef.current) return null;
      const ts = chartRef.current.timeScale();
      const t = ts.coordinateToTime(x);
      if (t !== null) return t as number;
      const { candles: cs, cursor } = useTraderStore.getState();
      const visible = cs.slice(0, cursor + 1);
      if (visible.length === 0) return null;
      const firstX = ts.timeToCoordinate(visible[0].time as Time);
      const lastX = ts.timeToCoordinate(visible[visible.length - 1].time as Time);
      if (firstX !== null && x <= firstX) return visible[0].time;
      if (lastX !== null && x >= lastX) return visible[visible.length - 1].time;
      return null;
    };

    const MAGNET_WEAK_PX = 12;

    // カーソル座標(x,y)を、マグネット設定に応じて直下の足の始値/高値/安値/終値のうち
    // 最も近いものへ吸着させる。strong は常に吸着、weak は MAGNET_WEAK_PX 以内に
    // 近づいた時だけ吸着、off は素通し。吸着後の価格とそのy座標を返す
    // （プレビュー描画はピクセル単位で行われるため、価格だけでなくyも一緒に返す）
    const magnetSnap = (x: number, y: number): { price: number; y: number } | null => {
      if (!seriesRef.current) return null;
      const rawPrice = seriesRef.current.coordinateToPrice(y);
      if (rawPrice === null) return null;
      const { magnetMode, candles: cs, cursor } = useTraderStore.getState();
      if (magnetMode === 'off' || cs.length === 0) return { price: rawPrice, y };
      const visible = cs.slice(0, cursor + 1);
      const t = pixelToTime(x);
      if (visible.length === 0 || t === null) return { price: rawPrice, y };
      const idx0 = Math.min(Math.max(candleIndexAt(visible, t), 0), visible.length - 1);
      let best = idx0, bestDx = Infinity;
      for (const i of [idx0, idx0 + 1]) {
        if (i < 0 || i >= visible.length) continue;
        const cx = timeToX(visible[i].time);
        if (cx === null) continue;
        const dx = Math.abs(cx - x);
        if (dx < bestDx) { bestDx = dx; best = i; }
      }
      const c = visible[best];
      let snappedPrice: number = rawPrice, snappedY = y, bestDy = Infinity;
      for (const v of [c.open, c.high, c.low, c.close]) {
        const vy = seriesRef.current.priceToCoordinate(v);
        if (vy === null) continue;
        const dy = Math.abs(vy - y);
        if (dy < bestDy) { bestDy = dy; snappedPrice = v; snappedY = vy; }
      }
      if (magnetMode === 'weak' && bestDy > MAGNET_WEAK_PX) return { price: rawPrice, y };
      return { price: snappedPrice, y: snappedY };
    };

    const onMouseDown = (e: MouseEvent) => {
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, isDrawingRect: isR, pickTarget: pick } = useTraderStore.getState();
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (pick !== null) return;

      if (isR) {
        if (!seriesRef.current || !chartRef.current) return;
        const snap = magnetSnap(x, y);
        if (snap === null) return;
        rectStart = { x, y: snap.y, price: snap.price };
        pendingRectEnd = { x, y: snap.y, price: snap.price };
        rectDragging = true;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        updateRectDraftBox(x, snap.y, x, snap.y);
        return;
      }

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
        if (target.kind === 'hline') useTraderStore.getState().selectLine({ kind: 'h', id: target.id });
        return;
      }
      const vId = findVLineNear(x);
      if (vId !== null) {
        draggingVId = vId;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'ew-resize';
        useTraderStore.getState().selectLine({ kind: 'v', id: vId });
        return;
      }
      const corner = findRectCornerNear(x, y);
      if (corner !== null) {
        draggingRectCorner = corner;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'nwse-resize';
        useTraderStore.getState().selectLine({ kind: 'rect', id: corner.rectId });
        return;
      }

      const edge = findRectEdgeNear(x, y);
      if (edge !== null) {
        draggingRectEdge = edge;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = edge.field === 'time1' || edge.field === 'time2' ? 'ew-resize' : 'ns-resize';
        useTraderStore.getState().selectLine({ kind: 'rect', id: edge.rectId });
        return;
      }

      const borderRectId = findRectBorderNear(x, y);
      if (borderRectId !== null) {
        if (!seriesRef.current || !chartRef.current) return;
        const { rects: rectsAtDown, candles: csAtDown, cursor: curAtDown } = useTraderStore.getState();
        const r = rectsAtDown.find(rr => rr.id === borderRectId);
        const visibleAtDown = csAtDown.slice(0, curAtDown + 1);
        const startTime = pixelToTime(x);
        const startPrice = seriesRef.current.coordinateToPrice(y);
        if (!r || startTime === null || startPrice === null || visibleAtDown.length === 0) return;
        draggingRectMoveId = borderRectId;
        rectMoveStart = {
          idx1: candleIndexAt(visibleAtDown, r.time1),
          idx2: candleIndexAt(visibleAtDown, r.time2),
          price1: r.price1, price2: r.price2,
          startIdx: candleIndexAt(visibleAtDown, startTime),
          startPrice,
        };
        chart.applyOptions({ handleScroll: false, handleScale: false });
        container.style.cursor = 'move';
        useTraderStore.getState().selectLine({ kind: 'rect', id: borderRectId });
        return;
      }

      const bodyRectId = findRectBodyNear(x, y);
      const { selected: currentSelected } = useTraderStore.getState();
      if (bodyRectId !== null) {
        useTraderStore.getState().selectLine({ kind: 'rect', id: bodyRectId });
      } else if (currentSelected !== null) {
        // 図形の外（余白）をクリックしたら選択解除する（TradingView等と同じ挙動）
        useTraderStore.getState().selectLine(null);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (rectDragging && rectStart) {
        const snap = magnetSnap(x, y);
        if (snap === null) return;
        pendingRectEnd = { x, y: snap.y, price: snap.price };
        updateRectDraftBox(rectStart.x, rectStart.y, x, snap.y);
        return;
      }

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
        // 水平線のみ描画ツールとしてマグネットの対象にする（TP/SL等の注文編集は対象外）
        const price = draggingTarget.kind === 'hline'
          ? magnetSnap(x, y)?.price ?? null
          : seriesRef.current.coordinateToPrice(y);
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
              // 中点ハンドルも同じフレームで追従させる（store更新を待つと
              // マウスボタンリリースまでハンドルだけ取り残されて不自然に見える）
              if (draggingTarget.kind === 'hline' && lineHandleElRef.current && seriesRef.current) {
                const hy = seriesRef.current.priceToCoordinate(pendingPrice);
                if (hy !== null) lineHandleElRef.current.style.top = `${hy - 4}px`;
              }
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
              // 中点ハンドルも同じフレームで追従させる（理由は水平線ドラッグと同じ）
              if (lineHandleElRef.current) lineHandleElRef.current.style.left = `${pendingVX - 4}px`;
            }
          });
        }
        return;
      }

      if (draggingRectCorner !== null) {
        if (!seriesRef.current || !chartRef.current) return;
        const price = magnetSnap(x, y)?.price ?? null;
        const time = pixelToTime(x);
        if (price === null || time === null) return;
        pendingRectCornerPos = { time, price };
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (draggingRectCorner === null || pendingRectCornerPos === null) return;
            if (!chartRef.current || !seriesRef.current) return;
            const el = rectElsRef.current.get(draggingRectCorner.rectId);
            const { rects: currentRects } = useTraderStore.getState();
            const r = currentRects.find(rr => rr.id === draggingRectCorner!.rectId);
            if (!el || !r) return;
            const otherTime = draggingRectCorner.timeField === 'time1' ? r.time2 : r.time1;
            const otherPrice = draggingRectCorner.priceField === 'price1' ? r.price2 : r.price1;
            const x1 = timeToX(pendingRectCornerPos.time);
            const x2 = timeToX(otherTime);
            const y1 = seriesRef.current.priceToCoordinate(pendingRectCornerPos.price);
            const y2 = seriesRef.current.priceToCoordinate(otherPrice);
            if (x1 === null || x2 === null || y1 === null || y2 === null) return;
            el.style.left = `${Math.min(x1, x2)}px`;
            el.style.top = `${Math.min(y1, y2)}px`;
            el.style.width = `${Math.abs(x2 - x1)}px`;
            el.style.height = `${Math.abs(y2 - y1)}px`;
            positionRectHandles(x1, x2, y1, y2);
          });
        }
        return;
      }

      if (draggingRectEdge !== null) {
        if (!seriesRef.current || !chartRef.current) return;
        const isTimeField = draggingRectEdge.field === 'time1' || draggingRectEdge.field === 'time2';
        const value = isTimeField ? pixelToTime(x) : (magnetSnap(x, y)?.price ?? null);
        if (value === null) return;
        pendingRectEdgeValue = value;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (draggingRectEdge === null || pendingRectEdgeValue === null) return;
            if (!chartRef.current || !seriesRef.current) return;
            const el = rectElsRef.current.get(draggingRectEdge.rectId);
            const { rects: currentRects } = useTraderStore.getState();
            const r = currentRects.find(rr => rr.id === draggingRectEdge!.rectId);
            if (!el || !r) return;
            const updated = { ...r, [draggingRectEdge.field]: pendingRectEdgeValue };
            const x1 = timeToX(updated.time1);
            const x2 = timeToX(updated.time2);
            const y1 = seriesRef.current.priceToCoordinate(updated.price1);
            const y2 = seriesRef.current.priceToCoordinate(updated.price2);
            if (x1 === null || x2 === null || y1 === null || y2 === null) return;
            el.style.left = `${Math.min(x1, x2)}px`;
            el.style.top = `${Math.min(y1, y2)}px`;
            el.style.width = `${Math.abs(x2 - x1)}px`;
            el.style.height = `${Math.abs(y2 - y1)}px`;
            positionRectHandles(x1, x2, y1, y2);
          });
        }
        return;
      }

      if (draggingRectMoveId !== null && rectMoveStart) {
        if (!seriesRef.current || !chartRef.current) return;
        const t = pixelToTime(x);
        const p = seriesRef.current.coordinateToPrice(y);
        if (t === null || p === null) return;
        const { candles: csMove, cursor: curMove } = useTraderStore.getState();
        const visibleMove = csMove.slice(0, curMove + 1);
        if (visibleMove.length === 0) return;
        pendingRectMoveDelta = { idx: candleIndexAt(visibleMove, t) - rectMoveStart.startIdx, dp: p - rectMoveStart.startPrice };
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            if (draggingRectMoveId === null || pendingRectMoveDelta === null || rectMoveStart === null) return;
            if (!chartRef.current || !seriesRef.current) return;
            const el = rectElsRef.current.get(draggingRectMoveId);
            if (!el) return;
            const { candles: csRaf, cursor: curRaf } = useTraderStore.getState();
            const visibleRaf = csRaf.slice(0, curRaf + 1);
            if (visibleRaf.length === 0) return;
            const newIdx1 = Math.min(Math.max(rectMoveStart.idx1 + pendingRectMoveDelta.idx, 0), visibleRaf.length - 1);
            const newIdx2 = Math.min(Math.max(rectMoveStart.idx2 + pendingRectMoveDelta.idx, 0), visibleRaf.length - 1);
            const x1 = timeToX(visibleRaf[newIdx1].time);
            const x2 = timeToX(visibleRaf[newIdx2].time);
            const y1 = seriesRef.current.priceToCoordinate(rectMoveStart.price1 + pendingRectMoveDelta.dp);
            const y2 = seriesRef.current.priceToCoordinate(rectMoveStart.price2 + pendingRectMoveDelta.dp);
            if (x1 === null || x2 === null || y1 === null || y2 === null) return;
            el.style.left = `${Math.min(x1, x2)}px`;
            el.style.top = `${Math.min(y1, y2)}px`;
            el.style.width = `${Math.abs(x2 - x1)}px`;
            el.style.height = `${Math.abs(y2 - y1)}px`;
            positionRectHandles(x1, x2, y1, y2);
          });
        }
        return;
      }

      // 価格軸ドラッグ等、こちらで検知できないスケール変更にも追従させる（コメントは冒頭のlet宣言を参照）
      if (!overlayResyncScheduled) {
        overlayResyncScheduled = true;
        requestAnimationFrame(() => {
          overlayResyncScheduled = false;
          syncVLines();
          syncRects();
          syncWeekLines();
          syncCloud();
        });
      }

      // ドラッグ中でなければ、ライン近傍でカーソルをホバー表示に
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, isDrawingRect: isR, pickTarget: pick } = useTraderStore.getState();
      if (!dH && !dV && !isM && !isR && pick === null) {
        const draft = findDraftNear(y);
        if (draft !== null) { container.style.cursor = 'ns-resize'; return; }
        const target = findPriceTargetNear(y);
        if (target !== null) { container.style.cursor = 'ns-resize'; return; }
        const vId = findVLineNear(x);
        if (vId !== null) { container.style.cursor = 'ew-resize'; return; }
        const corner = findRectCornerNear(x, y);
        if (corner !== null) { container.style.cursor = 'nwse-resize'; return; }
        const edge = findRectEdgeNear(x, y);
        if (edge !== null) { container.style.cursor = edge.field === 'time1' || edge.field === 'time2' ? 'ew-resize' : 'ns-resize'; return; }
        const border = findRectBorderNear(x, y);
        container.style.cursor = border !== null ? 'move' : 'default';
      }
    };

    const onMouseUp = () => {
      if (rectDragging) {
        rectDragging = false;
        chart.applyOptions({ handleScroll: true, handleScale: true });
        if (rectDraftBoxRef.current) rectDraftBoxRef.current.style.display = 'none';
        if (rectStart && pendingRectEnd && seriesRef.current && chartRef.current) {
          const t1 = pixelToTime(rectStart.x);
          const t2 = pixelToTime(pendingRectEnd.x);
          const p1 = rectStart.price;
          const p2 = pendingRectEnd.price;
          if (t1 !== null && t2 !== null && (t1 !== t2 || p1 !== p2)) {
            useTraderStore.getState().addRect(t1, p1, t2, p2);
          }
        }
        rectStart = null;
        pendingRectEnd = null;
        return;
      }
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
      if (draggingRectCorner !== null) {
        if (pendingRectCornerPos !== null) {
          useTraderStore.getState().updateRect(draggingRectCorner.rectId, {
            [draggingRectCorner.timeField]: pendingRectCornerPos.time,
            [draggingRectCorner.priceField]: pendingRectCornerPos.price,
          });
        }
        draggingRectCorner = null;
        pendingRectCornerPos = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
      }
      if (draggingRectEdge !== null) {
        if (pendingRectEdgeValue !== null) {
          useTraderStore.getState().updateRect(draggingRectEdge.rectId, {
            [draggingRectEdge.field]: pendingRectEdgeValue,
          });
        }
        draggingRectEdge = null;
        pendingRectEdgeValue = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
      }
      if (draggingRectMoveId !== null) {
        if (pendingRectMoveDelta !== null && rectMoveStart !== null) {
          const { candles: csUp, cursor: curUp } = useTraderStore.getState();
          const visibleUp = csUp.slice(0, curUp + 1);
          if (visibleUp.length > 0) {
            const newIdx1 = Math.min(Math.max(rectMoveStart.idx1 + pendingRectMoveDelta.idx, 0), visibleUp.length - 1);
            const newIdx2 = Math.min(Math.max(rectMoveStart.idx2 + pendingRectMoveDelta.idx, 0), visibleUp.length - 1);
            useTraderStore.getState().updateRect(draggingRectMoveId, {
              time1: visibleUp[newIdx1].time,
              time2: visibleUp[newIdx2].time,
              price1: rectMoveStart.price1 + pendingRectMoveDelta.dp,
              price2: rectMoveStart.price2 + pendingRectMoveDelta.dp,
            });
          }
        }
        draggingRectMoveId = null;
        rectMoveStart = null;
        pendingRectMoveDelta = null;
        chart.applyOptions({ handleScroll: true, handleScale: true });
        container.style.cursor = 'default';
      }
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Delete/Backspaceキーで選択中の水平線・垂直線・四角形を削除、Cmd/Ctrl+C・Vでコピー&ペースト
    // （Macのキーボードは物理削除キーが実は⌫=Backspaceで、fn+⌫でようやくDeleteになるため両方拾う）
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selected: sel, removeLine, removeVLine, removeRect } = useTraderStore.getState();
        if (!sel) return;
        if (sel.kind === 'h') removeLine(sel.id);
        else if (sel.kind === 'v') removeVLine(sel.id);
        else removeRect(sel.id);
        return;
      }

      if (!(e.metaKey || e.ctrlKey)) return;
      if (!seriesRef.current || !chartRef.current) return;

      if (e.key === 'c' || e.key === 'C') {
        const { selected: sel } = useTraderStore.getState();
        if (sel) clipboard = sel;
        return;
      }

      if (e.key === 'v' || e.key === 'V') {
        if (!clipboard) return;
        e.preventDefault();
        const store = useTraderStore.getState();
        if (clipboard.kind === 'h') {
          const src = store.lines.find(l => l.id === clipboard!.id);
          const y = src && seriesRef.current.priceToCoordinate(src.price);
          if (!src || y === null || y === undefined) return;
          const newPrice = seriesRef.current.coordinateToPrice(y + PASTE_OFFSET_PX);
          if (newPrice === null) return;
          store.duplicateLine(src.id, newPrice);
          const newId = useTraderStore.getState().nextLineId - 1;
          store.selectLine({ kind: 'h', id: newId });
          clipboard = { kind: 'h', id: newId };
        } else if (clipboard.kind === 'v') {
          const src = store.vlines.find(v => v.id === clipboard!.id);
          const x = src && timeToX(src.time);
          if (!src || x === null || x === undefined) return;
          const newTime = pixelToTime(x + PASTE_OFFSET_PX);
          if (newTime === null) return;
          store.duplicateVLine(src.id, newTime);
          const newId = useTraderStore.getState().nextVLineId - 1;
          store.selectLine({ kind: 'v', id: newId });
          clipboard = { kind: 'v', id: newId };
        } else {
          const src = store.rects.find(r => r.id === clipboard!.id);
          if (!src) return;
          const x1 = timeToX(src.time1), x2 = timeToX(src.time2);
          const y1 = seriesRef.current.priceToCoordinate(src.price1), y2 = seriesRef.current.priceToCoordinate(src.price2);
          if (x1 === null || x2 === null || y1 === null || y2 === null) return;
          const newTime1 = pixelToTime(x1 + PASTE_OFFSET_PX);
          const newTime2 = pixelToTime(x2 + PASTE_OFFSET_PX);
          const newPrice1 = seriesRef.current.coordinateToPrice(y1 + PASTE_OFFSET_PX);
          const newPrice2 = seriesRef.current.coordinateToPrice(y2 + PASTE_OFFSET_PX);
          if (newTime1 === null || newTime2 === null || newPrice1 === null || newPrice2 === null) return;
          store.duplicateRect(src.id, newTime1, newPrice1, newTime2, newPrice2);
          const newId = useTraderStore.getState().nextRectId - 1;
          store.selectLine({ kind: 'rect', id: newId });
          clipboard = { kind: 'rect', id: newId };
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);

    // ウィンドウリサイズ + Controls 高さ変化（ポジション増減）に追従
    const handleResize = () => {
      chart.applyOptions({
        width:  container.clientWidth,
        height: container.clientHeight,
      });
      syncVLines();
      syncRects();
      syncWeekLines();
      updateRRPreview();
      syncCloud();
      syncScrubber();
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
      window.removeEventListener('keydown', onKeyDown);
      scrubberTrackRef.current?.removeEventListener('mousedown', onScrubberDown);
      scrubberTrackRef.current?.removeEventListener('mouseenter', onScrubberEnter);
      scrubberTrackRef.current?.removeEventListener('mouseleave', onScrubberLeave);
      window.removeEventListener('mousemove', onScrubberMove);
      window.removeEventListener('mouseup', onScrubberUp);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      if (saveViewTimerRef.current !== undefined) window.clearTimeout(saveViewTimerRef.current);
      vlineElsRef.current.forEach(el => el.remove());
      vlineElsRef.current.clear();
      lineHandleElRef.current?.remove();
      lineHandleElRef.current = null;
      rectElsRef.current.forEach(el => el.remove());
      rectElsRef.current.clear();
      rectHandleElsRef.current.forEach(el => el.remove());
      rectHandleElsRef.current = [];
      weekLineElsRef.current.forEach(el => el.remove());
      weekLineElsRef.current = [];
      chart.remove();
      // chart.remove() で価格ラインも破棄されるため、次のマウント（StrictModeの
      // 二重実行や、4画面でのメインパネル切替による再マウント）で古い IPriceLine を
      // 参照し続けないようマップ側もクリアする（残すと applyOptions で
      // 「Cannot read properties of undefined (reading '_internal_state')」がクラッシュする）
      priceLineMapRef.current.clear();
      orderLineMapRef.current.clear();
      tpLineMapRef.current.clear();
      slLineMapRef.current.clear();
      orderTpLineMapRef.current.clear();
      orderSlLineMapRef.current.clear();
      draftLineMapRef.current.clear();
    };
  }, []);

  // 描画・計測・価格ピッキングモード中はカーソルを crosshair に
  useEffect(() => {
    if (containerRef.current && (isDrawingLine || isDrawingVLine || isMeasuring || isDrawingRect || pickTarget !== null)) {
      containerRef.current.style.cursor = 'crosshair';
    }
  }, [isDrawingLine, isDrawingVLine, isMeasuring, isDrawingRect, pickTarget]);

  // ものさしモードを解除したら表示を消す
  useEffect(() => {
    if (!isMeasuring && measureOverlayRef.current) {
      measureOverlayRef.current.style.display = 'none';
    }
  }, [isMeasuring]);

  // 水平線の再描画（ドラッグ中の price 更新も含めて毎回フル同期）
  // パネル切替直後などチャートが破棄されかけているタイミングでの例外は
  // try/catchで吸収し、画面全体のクラッシュ（黒画面）を防ぐ（errorLogに記録）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
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
    } catch (e) {
      logError('CandleChart:hlines', e);
    }
    syncVLinesRef.current();
  }, [lines, selected]);

  // 未約定注文（指値・逆指値）の価格ラインを再描画
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
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
    } catch (e) {
      logError('CandleChart:orderLines', e);
    }
  }, [pendingOrders]);

  // 未約定注文に紐づく TP / SL の価格ラインを再描画（約定前から表示）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
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
    } catch (e) {
      logError('CandleChart:orderTpSlLines', e);
    }
  }, [pendingOrders]);

  // ポジションの TP / SL 価格ラインを再描画
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
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
    } catch (e) {
      logError('CandleChart:tpSlLines', e);
    }
  }, [positions]);

  // 発注パネルの draft 価格（price/TP/SL）をプレビュー表示（ドット線で確定済みと区別）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
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
    } catch (e) {
      logError('CandleChart:draftLines', e);
    }
  }, [orderType, draftPrice, draftTP, draftSL]);

  // リスクリワード（TP/SL比率）プレビューの再計算
  useEffect(() => {
    updateRRPreviewRef.current();
  }, [orderType, draftPrice, draftTP, draftSL, candles, cursor]);

  // 垂直線の再描画（選択状態が変わった時も中点ハンドル表示を更新する）
  useEffect(() => {
    syncVLinesRef.current();
  }, [vlines, selected]);

  // 四角形の再描画（選択状態が変わった時もハンドル表示を更新する）
  useEffect(() => {
    syncRectsRef.current();
  }, [rects, selected]);

  // 価格軸の表示精度: 読み込んだペアの価格帯に合わせる（JPYクロス=小数3桁、それ以外=小数5桁）
  useEffect(() => {
    if (candles.length === 0) return;
    const precision = pricePrecision(candles[0].close);
    const minMove = 1 / 10 ** precision;
    const priceFormat = { type: 'price' as const, precision, minMove };
    seriesRef.current?.applyOptions({ priceFormat });
    emaSeriesRef.current?.applyOptions({ priceFormat });
    smaSeriesRef.current?.applyOptions({ priceFormat });
    bbBasisSeriesRef.current?.applyOptions({ priceFormat });
    bbUpper1SeriesRef.current?.applyOptions({ priceFormat });
    bbLower1SeriesRef.current?.applyOptions({ priceFormat });
    bbUpper2SeriesRef.current?.applyOptions({ priceFormat });
    bbLower2SeriesRef.current?.applyOptions({ priceFormat });
    senkouASeriesRef.current?.applyOptions({ priceFormat });
    senkouBSeriesRef.current?.applyOptions({ priceFormat });
    // 精度変更で価格軸の幅が変わるため、再描画後に実測してフロートパネルのクランプに反映
    requestAnimationFrame(() => {
      if (!chartRef.current) return;
      useTraderStore.getState().setChartMargins(
        chartRef.current.priceScale('right').width(),
        chartRef.current.timeScale().height(),
      );
    });
  }, [candles]);

  // 区切り線: candles 変化時に境界を再計算（1D足は週区切り、それ以外は日区切り）、showWeekLines 変化時は表示トグル
  useEffect(() => {
    weekBoundariesRef.current = computeSeparatorBoundaries(candles, timeframeSec);
    syncWeekLinesRef.current();
  }, [candles, timeframeSec]);

  useEffect(() => {
    syncWeekLinesRef.current();
  }, [showWeekLines]);

  // EMA 表示 ON/OFF
  useEffect(() => {
    emaSeriesRef.current?.applyOptions({ visible: showEMA });
  }, [showEMA]);

  // SMA14 表示 ON/OFF（EMA同様、非表示中も裏で計算は継続しておく）
  useEffect(() => {
    smaSeriesRef.current?.applyOptions({ visible: showSMA });
  }, [showSMA]);

  // ボリンジャーバンド 表示 ON/OFF（EMA同様、非表示中も裏で計算は継続しておく）
  useEffect(() => {
    bbBasisSeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper1SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower1SeriesRef.current?.applyOptions({ visible: showBB });
    bbUpper2SeriesRef.current?.applyOptions({ visible: showBB });
    bbLower2SeriesRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);

  // 雲 表示 ON/OFF（同様に非表示中も裏で計算を継続、canvas側は syncCloud 内で showCloud を判定）
  useEffect(() => {
    senkouASeriesRef.current?.applyOptions({ visible: showCloud });
    senkouBSeriesRef.current?.applyOptions({ visible: showCloud });
    syncCloudRef.current();
  }, [showCloud]);

  // エントリー / 決済マーカー
  useEffect(() => {
    seriesRef.current?.setMarkers(buildTradeMarkers(positions, closedTrades, currencySymbol(quoteCurrency)));
  }, [positions, closedTrades, quoteCurrency]);

  // 表示をリセット: TradingViewの「チャート表示をリセット」相当。全データを画面に
  // 収めるズームアウトではなく、時間軸のズーム・スクロール位置をデフォルトに戻し
  // （resetTimeScale）、価格軸の手動スケール調整（ドラッグ等）も解除してautoScaleへ戻す
  useEffect(() => {
    if (fitSignal === 0 || !chartRef.current) return;
    chartRef.current.timeScale().resetTimeScale();
    chartRef.current.priceScale('right').applyOptions({ autoScale: true });
  }, [fitSignal]);

  // 4画面時、他パネルの十字カーソルに追従表示する（自分がホバー元のときは何もしない）。
  // パネル切替の瞬間にチャートが破棄されかけている可能性があるため try/catch で保護し、
  // 万一失敗しても画面全体をクラッシュさせない（失敗はerrorLogに記録）
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current || crosshairSourceId === 'main') return;
    try {
      if (crosshairTime === null) {
        chartRef.current.clearCrosshairPosition();
        return;
      }
      const price = priceAtTime(candles, crosshairTime, timeframeSec);
      if (price === null) { chartRef.current.clearCrosshairPosition(); return; }
      chartRef.current.setCrosshairPosition(price, crosshairTime as Time, seriesRef.current);
    } catch (e) {
      logError('CandleChart:crosshairSync', e);
    }
  }, [crosshairSourceId, crosshairTime, candles]);

  // 最新足に固定: 縮尺は維持したまま、最新足が右オフセット(rightOffset)分の位置に来るよう追従
  useEffect(() => {
    if (scrollToLatestSignal === 0 || !chartRef.current) return;
    chartRef.current.timeScale().scrollToRealTime();
  }, [scrollToLatestSignal]);

  // リプレイモード: カーソル変化時にデータ更新（ローソク足 + EMA200）
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    const isStep =
      candles === prevCandlesRef.current &&
      cursor === prevCursorRef.current + 1;

    if (isStep) {
      seriesRef.current.update(toBar(candles[cursor]));
      updateEmaStep(candles[cursor]);
      updateSMAStep(candles, cursor);
      updateBBStep(candles, cursor);
      updateCloudStep(candles, cursor);
    } else {
      seriesRef.current.setData(candles.slice(0, cursor + 1).map(toBar));
      chartRef.current?.timeScale().scrollToRealTime();
      recomputeEmaFull(candles, cursor);
      recomputeSMAFull(candles, cursor);
      recomputeBBFull(candles, cursor);
      recomputeCloudFull(candles, cursor);
    }
    // 価格軸ドラッグ等で autoScale が無効化されたままだと、再生中にローソク足が
    // 上下にはみ出ても追従しなくなる。毎ステップ明示的に再有効化して縦も自動追従させる
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    // 可視範囲確定後に再同期（範囲変更イベントに頼らず確実に揃える）
    syncVLinesRef.current();
    syncRectsRef.current();
    syncWeekLinesRef.current();
    syncScrubberRef.current();

    prevCursorRef.current  = cursor;
    prevCandlesRef.current = candles;
  }, [candles, cursor]);

  // 時間軸の切替・新規CSV読み込み時、記憶しておいたズーム/スケール（縮尺）を復元したうえで、
  // 常に最新足に固定する（右端からの位置=barsFromRightではなく、常にrightOffset分の位置に揃える）
  // （リプレイモード側の setData/scrollToRealTime より後に実行し、その結果を上書きする）
  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return;
    const key = `${timeframeSec}:${dataVersion}`;
    if (restoredViewKeyRef.current === key) return;
    restoredViewKeyRef.current = key;

    const saved = loadChartView(timeframeSec);
    const totalBars = cursor + 1;
    // 記憶したズーム幅（span）が現在の表示可能本数を超える場合（読み込み直後でcursorが
    // 先頭に戻っている等）は復元すると破綻したlogical rangeになるため復元をスキップする
    if (saved && totalBars > 0 && saved.span <= totalBars) {
      chartRef.current.timeScale().setVisibleLogicalRange(relativeViewToLogicalRange(saved, totalBars));
    }
    chartRef.current.timeScale().scrollToRealTime();
  }, [timeframeSec, dataVersion, candles, cursor]);

  // 指定時刻を中心に表示（縮尺=現在の表示本数は維持したまま移動）
  // リプレイモード側の setData/scrollToRealTime より後に実行し、最終的な表示位置を確定させる。
  // 時刻ベースの座標（getVisibleRange/setVisibleRange）は setData 直後のレイアウト未確定時に
  // 不安定になることがあるため、足のインデックス（logical range）ベースで計算する。
  // 読み込み直後など一度もズームしていない状態は表示本数が極端に少ないことがあるため、
  // 最小表示本数を下回らないようにする
  useEffect(() => {
    if (centerSignal === 0 || !chartRef.current || candles.length === 0) return;
    const chart = chartRef.current;
    // centerTarget（時刻）に対応する足のインデックスを二分探索
    let lo = 0, hi = candles.length - 1, targetIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= centerTarget) { targetIdx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const currentSpan = logicalRange ? logicalRange.to - logicalRange.from : 0;
    const span = Math.max(currentSpan, MIN_JUMP_SPAN_BARS);
    const half = span / 2;
    chart.timeScale().setVisibleLogicalRange({ from: targetIdx - half, to: targetIdx + half });
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

  // SMA14: 移動窓(SMA_PERIOD)の合計を差分更新する単純移動平均
  function recomputeSMAFull(cs: Candle[], uptoIndex: number) {
    const data: LineData[] = [];
    let sum = 0;
    for (let i = 0; i <= uptoIndex; i++) {
      sum += cs[i].close;
      if (i >= SMA_PERIOD) sum -= cs[i - SMA_PERIOD].close;
      if (i >= SMA_PERIOD - 1) data.push({ time: cs[i].time as Time, value: sum / SMA_PERIOD });
    }
    smaSeriesRef.current?.setData(data);
    smaSumRef.current = sum;
  }

  function updateSMAStep(cs: Candle[], idx: number) {
    smaSumRef.current += cs[idx].close;
    if (idx >= SMA_PERIOD) smaSumRef.current -= cs[idx - SMA_PERIOD].close;
    if (idx < SMA_PERIOD - 1) return;
    smaSeriesRef.current?.update({ time: cs[idx].time as Time, value: smaSumRef.current / SMA_PERIOD });
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

  // 雲: 先行スパンA/Bを 26 本先の"足の時刻"に置いて描画（値自体は過去データのみで算出）
  function recomputeCloudFull(cs: Candle[], uptoIndex: number) {
    const aData: LineData[] = [];
    const bData: LineData[] = [];
    const points: { time: number; a: number; b: number }[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
      const pt = computeCloudPoint(cs, i);
      if (!pt) continue;
      const displaced = cloudDisplacedTime(cs, i, timeframeSec);
      aData.push({ time: displaced as Time, value: pt.a });
      bData.push({ time: displaced as Time, value: pt.b });
      points.push({ time: displaced, a: pt.a, b: pt.b });
    }
    senkouASeriesRef.current?.setData(aData);
    senkouBSeriesRef.current?.setData(bData);
    cloudDataRef.current = points;
    syncCloudRef.current();
  }

  function updateCloudStep(cs: Candle[], idx: number) {
    const pt = computeCloudPoint(cs, idx);
    if (!pt) return;
    const displaced = cloudDisplacedTime(cs, idx, timeframeSec);
    senkouASeriesRef.current?.update({ time: displaced as Time, value: pt.a });
    senkouBSeriesRef.current?.update({ time: displaced as Time, value: pt.b });
    cloudDataRef.current = [...cloudDataRef.current, { time: displaced, a: pt.a, b: pt.b }];
    syncCloudRef.current();
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onMouseLeave={() => {
        const s = useTraderStore.getState();
        if (s.crosshairSourceId === 'main') s.setCrosshair(null, null);
      }}
    >
      <ChartHeader
        symbol={symbol}
        timeframeLabel={timeframeLabel}
        timeframeSec={timeframeSec}
        onSelectTimeframe={sec => setTimeframe(sec)}
        disabled={!isLoaded}
      />
      <canvas ref={cloudCanvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%', zIndex: 5 }} />
      {/* 四角形・垂直線のオーバーレイは価格軸の領域には侵入させない。overflow:hiddenと
          right:chartRightMarginで、価格軸に被る位置までスクロール/リサイズされた図形は
          その手前で切れて見えるようにする（スクラバーの右クランプと同じ考え方） */}
      <div ref={rectOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 9 }}>
        <div ref={rectDraftBoxRef} style={{ position: 'absolute', display: 'none' }} />
      </div>
      <div ref={weekOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 10 }} />
      <div ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 11 }} />
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
      {/* 全期間スクラバー: YouTubeのシークバーのように全体に対する表示位置・幅を示し、
          ドラッグで平行移動・余白クリックでジャンプできる。価格軸に被らないよう右側を除き、
          時間軸の日付ラベル（chartBottomMargin分）とも被らないよう、その上に乗せる。
          普段は薄く表示し、マウスを近づけた時だけはっきり見えるようにする（当たり判定自体は
          常に有効。判定域を実際の見た目より少し広めに取り、掴みやすくしている） */}
      <div
        ref={scrubberTrackRef}
        title="ドラッグで移動、クリックでジャンプ"
        style={{
          position: 'absolute', left: 0, right: `${chartRightMargin}px`, bottom: `${chartBottomMargin}px`,
          height: '20px', cursor: 'pointer', zIndex: 14,
          opacity: 0.2, transition: 'opacity 0.15s ease',
        }}
      >
        <div style={{
          position: 'absolute', top: '8px', left: 0, right: 0, height: '4px',
          backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '2px', pointerEvents: 'none',
        }} />
        <div
          ref={scrubberThumbRef}
          style={{
            position: 'absolute', top: '6px', height: '8px',
            backgroundColor: 'rgba(66,165,245,0.55)', border: '1px solid rgba(66,165,245,0.9)',
            borderRadius: '3px', pointerEvents: 'none', display: 'none',
          }}
        />
      </div>
    </div>
  );
}
