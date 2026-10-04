import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, LineStyle, CrosshairMode,
  type IChartApi, type ISeriesApi, type CandlestickSeriesOptions,
  type Time, type Logical, type UTCTimestamp, type CandlestickData, type IPriceLine,
} from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { Candle, TimeframeSec } from '../types';
import { TIMEFRAMES, HIDABLE_TIMEFRAMES, isHiddenTimeframesVisibleAt } from '../types';
import { inferPipSize, pricePrecision } from '../lib/pips';
import { CHART_FONT_FAMILY, CHART_AXIS_TEXT_COLOR, CHART_AXIS_FONT_SIZE, DASH_TO_STYLE } from '../lib/chartTheme';
import { ChartHeader, type RestrictOption } from './ChartHeader';
import { loadChartView, saveChartView, relativeViewToLogicalRange } from '../lib/chartViewState';
import { computeSeparatorBoundaries } from '../lib/weekLines';
import { computeSessionBands, type SessionBand } from '../lib/sessions';
import { computeEMA, computeSMA, computeBB, computeCloud, computeATR, computeTail, EMA_PERIOD } from '../lib/indicators';
import { logError } from '../lib/errorLog';
import { initDuckDB, queryCandles } from '../lib/duckdb';
import { findBucketIndexContaining, buildPartialCandle } from '../lib/partialCandle';
import { createSyncWeekLines } from './chart/weekLinesOverlay';
import { createSyncSessions } from './chart/sessionsOverlay';
import { createSyncTradeMarkers } from './chart/tradeMarkersOverlay';
import { createScrubber } from './chart/scrubber';
import { createLinesOverlay } from './chart/linesOverlay';
import { createRectsOverlay } from './chart/rectsOverlay';
import { createSyncTrendLines } from './chart/trendLinesOverlay';
import { createSyncChannels } from './chart/channelsOverlay';
import { createSyncArrows } from './chart/arrowsOverlay';
import { createSyncBrushes } from './chart/brushesOverlay';
import { createSyncTexts } from './chart/textsOverlay';
import { createSyncCloud } from './chart/cloudOverlay';
import { createUpdateRRPreview } from './chart/rrPreviewOverlay';
import { createHitTests, type DragTarget } from './chart/hitTest';
import { createCoordinateHelpers } from './chart/coordinates';
import { createKeyboardHandler } from './chart/keyboard';
import { createTextEditor } from './chart/textEditing';
import { CONSUMED, combineTools, type DragSession } from './chart/drag';
import { createTwoPointTool } from './chart/twoPointTool';
import { createChannelTool } from './chart/channelTool';
import { createRectTool } from './chart/rectTool';
import { createBrushTool } from './chart/brushTool';
import { createPriceLineTools } from './chart/priceLineTool';
import { createTextMoveTool } from './chart/textMoveTool';
import { createMeasureTool } from './chart/measureTool';
import { createVLineTool } from './chart/vlineTool';
import { usePriceLines } from './chart/usePriceLines';
import {
  useIndicatorSeries, EMA_COLOR, SMA_COLOR, BB_BASIS_COLOR, BB_SILVER, CLOUD_A_COLOR, CLOUD_B_COLOR,
} from './chart/useIndicatorSeries';
import {
  useViewRangeCommands, useViewRangeSync, CHART_RIGHT_OFFSET_BARS, type FollowAnchor,
} from './chart/useViewRange';

// 非メインパネルでの「ドラッグではなくクリックならメインに昇格」判定用
const CLICK_TOLERANCE_PX = 6;
// 水平線・垂直線等の透明抜きで、ヒゲ区間（高値〜安値のうち実体を除く部分）に使う幅。
// lightweight-charts自体はヒゲの実描画幅を公開していないため近似値
const WICK_CUTOUT_PX = 2;
const toBar = (c: Candle): CandlestickData => ({
  time: c.time as Time,
  open: c.open, high: c.high, low: c.low, close: c.close,
});

// slot/isMain/timeframeSecは3画面/4画面レイアウトで複数インスタンスとして使うためのprops。
// 省略時（1画面時）は今まで通り「唯一のメインパネル」として振る舞う（isMain=true, slot=0）。
// isMain=falseの時、timeframeSecは自分が表示すべき時間軸（App.tsx側でquad3/quad4
// Timeframes[slot]から計算して渡す）を指す（省略時はグローバルのメイン時間足に
// フォールバックするが、非メインでは常に渡される想定）
export function CandleChart({
  slot = 0,
  isMain = true,
  timeframeSec: timeframeSecProp,
}: { slot?: number; isMain?: boolean; timeframeSec?: TimeframeSec } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
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
  const handleResizeRef = useRef<() => void>(() => {});
  const priceLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const tpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const slLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const positionEntryLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderTpLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const orderSlLineMapRef = useRef<Map<number, IPriceLine>>(new Map());
  const draftLineMapRef = useRef<Map<'price' | 'tp' | 'sl', IPriceLine>>(new Map());
  const vlineElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  // 垂直線の線本体（見た目）は専用canvasに自前描画し、四角形の縦線と同じdestination-outで
  // ロウソク足と重なった部分を透明に抜く（vlineElsRef側のDOMはラベルの位置決め用アンカーとして残す）
  const vlineCanvasRef = useRef<HTMLCanvasElement>(null);
  // 水平線も同じ理由でcanvas自前描画に切り替える。ただし価格軸のラベル
  // （axisLabelVisible）はSeries Primitives対象外のcanvas（このオーバーレイの外側）
  // が描くため、createPriceLine自体は残し lineVisible:false で線本体だけ隠す
  const hlineCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawHLineCanvasRef = useRef<() => void>(() => {});
  const lineHandleElRef = useRef<HTMLDivElement | null>(null); // 選択中の水平線/垂直線の中点ハンドル（常に1個分のみ）
  const syncVLinesRef = useRef<() => void>(() => {});
  const rectHandleOverlayRef = useRef<HTMLDivElement>(null);
  const rectHandleElsRef = useRef<HTMLDivElement[]>([]); // 選択中の四角形の4隅ハンドル（常に1個の四角形分のみ）
  const rectCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncRectsRef = useRef<() => void>(() => {});
  const trendCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncTrendLinesRef = useRef<() => void>(() => {});
  const channelCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncChannelsRef = useRef<() => void>(() => {});
  // 平行チャネルの「基準線は引いたがオフセット確定クリック待ち」の間にツールバーで別の
  // ツールへ切り替える等でisDrawingChannelがfalseになった時、待機中プレビューだけが
  // 残り続けないよう破棄する（下のuseEffectから呼ぶ）
  const cancelChannelAwaitRef = useRef<() => void>(() => {});
  const arrowCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncArrowsRef = useRef<() => void>(() => {});
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);
  const syncBrushesRef = useRef<() => void>(() => {});
  const textOverlayRef = useRef<HTMLDivElement>(null);
  const textElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncTextsRef = useRef<() => void>(() => {});
  const weekOverlayRef = useRef<HTMLDivElement>(null);
  const weekLineElsRef = useRef<HTMLDivElement[]>([]);
  const weekBoundariesRef = useRef<number[]>([]);
  const syncWeekLinesRef = useRef<() => void>(() => {});
  const sessionOverlayRef = useRef<HTMLDivElement>(null);
  const sessionElsRef = useRef<HTMLDivElement[]>([]);
  const sessionBandsRef = useRef<SessionBand[]>([]);
  const sessionMarkerElRef = useRef<HTMLDivElement | null>(null);
  const syncSessionsRef = useRef<() => void>(() => {});
  // トレード履歴マーカー（エントリー/決済）。ローソク足・インジケータと重ならないよう
  // セッション帯と同じ下部の専用行にDOM要素で描く（以前はlightweight-charts標準の
  // シリーズマーカーで足の高安のすぐ外側に描いており、密集すると価格やインジケータと
  // 重なって見づらいという指摘を受けて撤去した）
  const tradeMarkerOverlayRef = useRef<HTMLDivElement>(null);
  const tradeMarkerElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const tradeMarkerLineElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const syncTradeMarkersRef = useRef<() => void>(() => {});
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
  const mainDisplayTime = useTraderStore(s => s.mainDisplayTime);
  const positions = useTraderStore(s => s.positions);
  const pendingOrders = useTraderStore(s => s.pendingOrders);
  const closedTrades = useTraderStore(s => s.closedTrades);
  const quoteCurrency = useTraderStore(s => s.quoteCurrency);
  const symbol = useTraderStore(s => s.symbol);
  const lines     = useTraderStore(s => s.lines);
  const vlines    = useTraderStore(s => s.vlines);
  const rects     = useTraderStore(s => s.rects);
  const trendLines = useTraderStore(s => s.trendLines);
  const channels  = useTraderStore(s => s.channels);
  const arrows    = useTraderStore(s => s.arrows);
  const brushes   = useTraderStore(s => s.brushes);
  const texts     = useTraderStore(s => s.texts);
  const selected  = useTraderStore(s => s.selected);
  const isDrawingLine  = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring    = useTraderStore(s => s.isMeasuring);
  const isDrawingRect  = useTraderStore(s => s.isDrawingRect);
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingChannel = useTraderStore(s => s.isDrawingChannel);
  const isDrawingArrow = useTraderStore(s => s.isDrawingArrow);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const isDrawingText  = useTraderStore(s => s.isDrawingText);
  const pickTarget     = useTraderStore(s => s.pickTarget);
  const isJumpSync     = useTraderStore(s => s.isJumpSync);
  const jumpSyncSignal = useTraderStore(s => s.jumpSyncSignal);
  const jumpSyncTarget = useTraderStore(s => s.jumpSyncTarget);
  const jumpSyncSourceId = useTraderStore(s => s.jumpSyncSourceId);
  const orderType      = useTraderStore(s => s.orderType);
  const draftPrice     = useTraderStore(s => s.draftPrice);
  const draftTP        = useTraderStore(s => s.draftTP);
  const draftSL        = useTraderStore(s => s.draftSL);
  const showEMA   = useTraderStore(s => s.showEMA);
  const showSMA   = useTraderStore(s => s.showSMA);
  const showBB    = useTraderStore(s => s.showBB);
  const showCloud = useTraderStore(s => s.showCloud);
  const overlaysHidden = useTraderStore(s => s.overlaysHidden);
  const showHLinePriceLabel = useTraderStore(s => s.showHLinePriceLabel);
  const showVLineDateLabel = useTraderStore(s => s.showVLineDateLabel);
  const mainTimeframeSec = useTraderStore(s => s.timeframeSec);
  const mainRevealedUntil = useTraderStore(s => s.mainRevealedUntil);
  const finestSourceCandles = useTraderStore(s => s.finestSourceCandles);
  const finestSourceCursor = useTraderStore(s => s.finestSourceCursor);
  const setTimeframe = useTraderStore(s => s.setTimeframe);
  const setQuadTimeframe = useTraderStore(s => s.setQuadTimeframe);
  const restrictKindToTimeframe = useTraderStore(s => s.restrictKindToTimeframe);
  const showKindOnAllTimeframes = useTraderStore(s => s.showKindOnAllTimeframes);
  const chartLayout = useTraderStore(s => s.chartLayout);
  const preMultiLayout = useTraderStore(s => s.preMultiLayout);
  const isLoaded = useTraderStore(s => s.isLoaded);
  const dataVersion = useTraderStore(s => s.dataVersion);
  const showWeekLines = useTraderStore(s => s.showWeekLines);
  const showSessions = useTraderStore(s => s.showSessions);
  const tradeMarkersVisibleMap = useTraderStore(s => s.tradeMarkersVisible);
  const toggleTradeMarkersForTimeframe = useTraderStore(s => s.toggleTradeMarkersForTimeframe);
  const fitSignal  = useTraderStore(s => s.fitSignal);
  const scrollToLatestSignal = useTraderStore(s => s.scrollToLatestSignal);
  const followLatest = useTraderStore(s => s.followLatest);
  const isPlaying = useTraderStore(s => s.isPlaying);
  const centerSignal = useTraderStore(s => s.centerSignal);
  const centerTarget = useTraderStore(s => s.centerTarget);
  const crosshairSourceId = useTraderStore(s => s.crosshairSourceId);
  const crosshairTime = useTraderStore(s => s.crosshairTime);
  const chartRightMargin = useTraderStore(s => s.chartRightMargin);
  const chartBottomMargin = useTraderStore(s => s.chartBottomMargin);
  // 4画面時、クロスヘア同期の自分自身のID。'main'は文字列として固定の特別扱い
  // （store側のコメント通り「'main'またはミニ枠のslot番号文字列」という既存の取り決め）
  const mySourceId = isMain ? 'main' : String(slot);
  // isMain=falseの時はこのインスタンス専用の時間軸（quadTimeframes[slot]）を使う。
  // isMain=trueの時はグローバルのメイン時間足（リプレイ/約定判定の正）と常に一致する
  const timeframeSec = isMain ? mainTimeframeSec : (timeframeSecProp ?? mainTimeframeSec);
  const timeframeLabel = TIMEFRAMES.find(tf => tf.sec === timeframeSec)?.label ?? '';
  // このパネルの時間足でトレード履歴マーカーを表示するか（時間足単位の設定、未登録=表示）
  const tradeMarkersVisible = tradeMarkersVisibleMap[timeframeSec] !== false;

  // isMain=falseの時、このインスタンス専用に自前集計した足データ。
  // isMain=trueの時は使わない（グローバルのcandlesをそのまま使う）
  const [nonMainCandles, setNonMainCandles] = useState<Candle[]>([]);
  useEffect(() => {
    if (isMain) return;
    if (!isLoaded) { setNonMainCandles([]); return; }
    let cancelled = false;
    (async () => {
      const db = await initDuckDB();
      const cs = await queryCandles(db, timeframeSec);
      if (!cancelled) setNonMainCandles(cs);
    })();
    return () => { cancelled = true; };
  }, [isMain, isLoaded, dataVersion, timeframeSec]);
  // メインの現在足が閉じた時点（＝これより先は「未来」として隠す境界）。
  // candles[cursor].time + mainTimeframeSecで都度計算し直すのではなく、store側で保持している
  // mainRevealedUntilをそのまま使うこと——メインが形成中（未確定）のバケットを昇格直後に
  // 指している場合、candles[cursor]はその形成中バケット（バケット開始時刻）でmainTimeframeSec
  // も新しい時間足のものなので、計算し直すと実際の開示境界より大きくずれた値になり、非メインに
  // 降格したパネル（直前までメインで、切替の前後で実際には何も開示状況が変わっていない）が
  // 突然余分な未来の足まで表示してしまう（先出し）→ 無関係な再描画が起きて見えていた
  const nonMainCursorEnd = mainRevealedUntil ??
    (candles[cursor]?.time !== undefined ? candles[cursor].time + mainTimeframeSec : undefined);
  // filter()は呼ぶたびに新しい配列参照を返すため、useMemoを挟まないと依存に使う
  // useEffectが実質毎レンダー発火してしまう（値が同じでも参照が変わるため）。
  // ただしnonMainCursorEndはメインのcursorが1本進むたびに毎回変わる（=useMemoの依存自体は
  // 毎tick変化する）ため、useMemoだけでは不十分——上位足（1H/4H/1D）はメインが1本進んでも
  // 自分の足がまだ閉じていないことの方が多く、その場合filter結果の中身（本数・最後の足）は
  // 前回と同じなのに新しい配列参照が返ってしまい、下の「非メインへのsetData」effectが本来
  // 不要なタイミングでも毎tick再実行されてしまう（series.setDataを毎tick呼ぶことになり、
  // 「最新足に固定」のscrollToRealTime()アニメーションが完了する前に次のtickのsetDataで
  // 巻き戻され、1D以外は何回か押さないと最新足まで追従しない不具合の原因になっていた）。
  // 中身（本数・両端の足）が前回と変わっていなければ前回の配列参照をそのまま返して
  // 参照を安定させる（同じ`nonMainCandles`からのprefixフィルタなので要素の中身比較は不要、
  // 本数と両端の要素が同じなら中身も同じと判定できる）
  // 非メインの直前setData内容（再生中の末尾だけの差分更新の判定用）。emaClosedは末尾1本前のEMA値
  const nonMainPrevRef = useRef<{ source: Candle[]; tf: number; data: Candle[]; emaClosed: number } | null>(null);
  const nonMainVisibleRef = useRef<Candle[]>([]);
  const nonMainVisibleSourceRef = useRef<Candle[] | null>(null);
  const nonMainVisible = useMemo(() => {
    const next = nonMainCursorEnd === undefined
      ? nonMainCandles
      : nonMainCandles.filter(c => c.time + timeframeSec <= nonMainCursorEnd);
    const prev = nonMainVisibleRef.current;
    const sameSource = nonMainVisibleSourceRef.current === nonMainCandles;
    const sameContent = sameSource && prev.length === next.length &&
      (next.length === 0 || (prev[0] === next[0] && prev[next.length - 1] === next[next.length - 1]));
    const closed = sameContent ? prev : next;
    if (!sameContent) {
      nonMainVisibleRef.current = next;
      nonMainVisibleSourceRef.current = nonMainCandles;
    }

    // 形成中（まだ閉じていない）最新足を末尾に追加する。「上位足が閉じるまで何も
    // 出さない」だと、メインが1本進むたびに上位足の表示が2〜3日分も遅れて見え、
    // しかもバケットが閉じた瞬間だけ1日分ドンと進むように見えて不自然（実際に指摘を
    // 受けて判明）。closed（上のsameContent最適化対象）とは別に、こちらは意図的に
    // メインが1本進むたびに毎回新しい配列を返す（形成中の足はメインの進行に合わせて
    // 中身が変わり続けるべきものなので安定化の対象外にする）
    const curTime = candles[cursor]?.time;
    if (curTime === undefined || nonMainCandles.length === 0) return closed;
    // バケット位置の探索基準はcurTime（メイン現在足の開始時刻）ではなくnonMainCursorEnd
    // （＝メイン現在足の終了時刻、closedのフィルタ基準と同じ）を使うこと。非メインが
    // メインより細かい時間足の場合、curTimeはメイン現在足の「開始」でしかなく、closed
    // 側は既にそれより後（メイン現在足の終了）までのバケットを含んでいるため、curTime
    // 基準で探すとclosedの最後より過去のバケットを見つけてしまい、setData時に
    // 「data must be asc ordered by time」で丸ごとクラッシュする不具合を実際に踏んだ
    const searchTime = nonMainCursorEnd ?? curTime;
    const bi = findBucketIndexContaining(nonMainCandles, searchTime);
    if (bi < 0) return closed;
    const bucketStart = nonMainCandles[bi].time;
    // 既にclosed側に含まれている（＝確定済み）バケットなら追加しない。念のため
    // 「closedの最後より過去」も弾く（時系列逆転によるsetDataクラッシュの保険）
    if (closed.length > 0 && bucketStart <= closed[closed.length - 1].time) return closed;
    // nonMainCandles側の値はCSV全期間（未来分も含む）から集計済みのため使えない
    // （先出し防止）。finestSourceCandles（実際にカーソルを動かした時点のメインの
    // 確定済み足）からこのバケット範囲だけを自前で再集計する——グローバルなcandles/
    // cursorをそのまま使うと、メイン切替直後にメイン自体が粗い時間足になっていた
    // 場合、このパネルより粗いデータからは形成中足を再集計できず出せなくなる
    const forming = buildPartialCandle(finestSourceCandles, finestSourceCursor, bucketStart, bucketStart + timeframeSec);
    if (forming === null) return closed;
    return [...closed, forming];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonMainCandles, nonMainCursorEnd, timeframeSec, candles, cursor, finestSourceCandles, finestSourceCursor]);
  // このインスタンスが実際に描画すべき足データ（メインはグローバル、非メインは上記の自前集計＋未来隠し）
  const displayCandles = isMain ? candles : nonMainVisible;

  // ATR(14)バッジ用。このパネル自身の時間軸・今の位置（メインはcursor、非メインは
  // displayCandlesの末尾＝effectiveCursorRefと同じ考え方）で計算する
  const atrPips = useMemo(() => {
    const idx = isMain ? cursor : displayCandles.length - 1;
    if (idx < 0 || idx >= displayCandles.length) return null;
    const atr = computeATR(displayCandles, idx);
    if (atr === null) return null;
    return atr / inferPipSize(displayCandles[idx].close);
  }, [displayCandles, isMain, cursor]);

  // ヘッダーの「この時間足のみ表示」／「全時間足で表示に戻す」ドロップダウン用。どちらも
  // このパネルで表示中の描画が対象。前者は「この時間足限定」にまだなっていないもの、後者は
  // 他の時間足で非表示に制限されているもの（＝制限をかけたこの時間足のパネルで戻せる）。
  // 描画種類を1項目ずつ（同じ種類が複数あっても1つにまとめる）、0件の種類は出さない
  const [restrictOptions, restoreOptions] = useMemo(() => {
    const groups: { kind: RestrictOption['kind']; label: string; items: { hiddenTimeframes?: TimeframeSec[] }[] }[] = [
      { kind: 'h', label: '水平線', items: lines },
      { kind: 'v', label: '垂直線', items: vlines },
      { kind: 'rect', label: '四角形', items: rects },
      { kind: 'trend', label: 'トレンドライン', items: trendLines },
      { kind: 'channel', label: '平行チャネル', items: channels },
      { kind: 'arrow', label: '矢印', items: arrows },
      { kind: 'brush', label: 'ブラシ', items: brushes },
      { kind: 'text', label: 'テキスト', items: texts },
    ];
    const isOnlyHere = (o: { hiddenTimeframes?: TimeframeSec[] }) =>
      (o.hiddenTimeframes?.length ?? 0) >= HIDABLE_TIMEFRAMES.length - 1;
    const build = (pick: (o: { hiddenTimeframes?: TimeframeSec[] }) => boolean) => groups
      .map(g => ({ kind: g.kind, label: g.label, count: g.items.filter(o => isHiddenTimeframesVisibleAt(o, timeframeSec) && pick(o)).length }))
      .filter(o => o.count > 0);
    return [
      build(o => !isOnlyHere(o)),
      build(o => (o.hiddenTimeframes?.length ?? 0) > 0),
    ];
  }, [lines, vlines, rects, trendLines, channels, arrows, brushes, texts, timeframeSec]);

  // マウント時1回のみ実行される巨大なイベント設定用useEffect（下のchart初期化）はpropsを
  // クロージャで固定してしまうため、4画面でisMain/slotがremountなしに切り替わることに
  // 対応できない。イベントハンドラ内から常に最新値を読めるようrefに都度反映しておく
  const isMainRef = useRef(isMain);
  const slotRef = useRef(slot);
  const mySourceIdRef = useRef(mySourceId);
  const nonMainCandlesRef = useRef(nonMainCandles);
  // Phase 2: 非メインでもドラッグ/当たり判定を動かすため、四角形の足インデックススナップ・
  // マグネットスナップ等が参照する「今表示している足配列」「今の実質カーソル（末尾index）」を
  // refで持つ。メインはグローバルcandles/cursorそのもの、非メインは自前集計＋未来隠しクリップ
  // 済みのdisplayCandlesとその末尾index（非メインには「カーソル」という概念自体が無いため、
  // 見えている最後の足＝末尾を「今の位置」とみなす）
  const displayCandlesRef = useRef(displayCandles);
  const effectiveCursorRef = useRef(isMain ? cursor : displayCandles.length - 1);
  // このインスタンスが実際に表示している時間軸（isMain=falseなら自分のtimeframeSecProp）。
  // マウント時1回だけのeffectはpropsをクロージャで固定するため、非メインパネルの
  // ヘッダードロップダウンで時間軸を変えてもここが古い値のまま——他のref同様に同期する
  const timeframeSecRef = useRef(timeframeSec);
  // 再生中かどうか。カーソル変化時のデータ同期effect（isStep判定に使うためisPlaying自体は
  // depsに入れられない）から最新値を読むためのref
  const isPlayingRef = useRef(isPlaying);
  // メイン→非メインへ降格した瞬間を検出するため（デフォルトisMain=trueだと初回マウントを
  // 誤って「降格」扱いしてしまうため、非メインpropsで始まるインスタンスも考慮してisMainの
  // 初期値をそのまま入れておく）
  const prevIsMainRef = useRef(isMain);
  useEffect(() => {
    // メイン→非メインへ降格した瞬間、その時点の実際の表示位置を追従アンカーとして採用する。
    // 降格直後の非メインは自前集計の足データがまだ空（初めて非メインになる枠）か古いままで、
    // 下のeffectRefs更新後のeffectiveCursorRef（=nonMainVisibleの末尾）が-1になり、
    // captureFollowAnchorFromCurrentViewでは捕捉できない（アンカー未設定のまま最新足へ
    // 飛んでしまう——ジャンプ後にメインを切り替えると降格した枠が動く不具合の原因）。
    // effectiveCursorRefを上書きする前の値（=メイン時のcursor）とチャートの現在の可視範囲から
    // 直接アンカーを作る
    if (prevIsMainRef.current && !isMain) {
      const range = chartRef.current?.timeScale().getVisibleLogicalRange();
      const lastIdx = effectiveCursorRef.current;
      if (range && range.to > range.from && lastIdx >= 0) {
        followAnchorRef.current = { span: range.to - range.from, offset: range.to - lastIdx };
      }
    }
    isMainRef.current = isMain;
    slotRef.current = slot;
    mySourceIdRef.current = mySourceId;
    nonMainCandlesRef.current = nonMainCandles;
    timeframeSecRef.current = timeframeSec;
    displayCandlesRef.current = displayCandles;
    effectiveCursorRef.current = isMain ? cursor : displayCandles.length - 1;
    isPlayingRef.current = isPlaying;
    // メインの間はfollowLatestがOFFだとcaptureFollowAnchorFromCurrentView側の
    // isFollowActiveNow()ガードで弾かれ、followAnchorRefが更新されないまま（null）に
    // なりがち（ジャンプ・パン等でメインの表示位置を動かしても捕捉されない）。この状態で
    // 別パネルをメインへ昇格させてこの枠が降格すると、非メインの「常時追従」effectが
    // null＝アンカー未設定と判定し、既定値（画面右端＝真の最新足）にリセットしてしまう
    // ——「Aをメインに昇格→Bが最新足に戻る」のAB逆パターンとして実際に踏んだ（前回直した
    // 「ジャンプ直後に降格して戻る」不具合とは発生タイミングが違う、同根の別ケース）。
    // 降格した瞬間、その時点の実際の表示位置をアンカーとして採用することで、降格後も
    // 直前の見た目のまま追従を続けられるようにする
    prevIsMainRef.current = isMain;
  }, [isMain, slot, mySourceId, nonMainCandles, displayCandles, cursor, timeframeSec, isPlaying]);
  // 非メイン時、クリック（ドラッグでない）でメインへ昇格させるための始点記録
  const nonMainMouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  // 非メイン時、新しいデータセットに切り替わった時だけ画面フィットするための直前値記憶
  const fittedNonMainDataRef = useRef<Candle[] | null>(null);
  // メイン用データ同期effectが「非メイン→メイン昇格直後の初回実行」を検出するためのフラグ
  const wasMainForDataSyncRef = useRef(false);
  // メインだった枠が降格した直後の1回だけ、非メイン同期effectの「新データ→フィット」を
  // スキップするためのフラグ。isMainがtrueになるたびに毎回立て直す（降格→再昇格→再降格の
  // ような繰り返しにも対応するため、一度消費したら次にまたメインになるまで立たない）
  const skipNextNonMainFitRef = useRef(false);
  useEffect(() => {
    if (isMain) skipNextNonMainFitRef.current = true;
  }, [isMain]);

  const prevCursorRef  = useRef(-1);
  const prevCandlesRef = useRef<Candle[]>([]);
  const restoredViewKeyRef = useRef<string | null>(null);
  const saveViewTimerRef = useRef<number | undefined>(undefined);

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
      // グリッド線はSeries Primitivesの対象外（zOrderで重なり順を制御できない）で、
      // 常に四角形（zOrder:'bottom'）より前面に描画される。四角形の境界線と交差する
      // 箇所でグリッド線が上に出てしまう既知の制約があるが、グリッド線自体は残す方を
      // 優先（一度非表示にしたが、見た目が変わりすぎるとの指摘を受けて元に戻した）
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
          // 4H/1D/1W/1Mは、日境界がブローカー時間バケット+JST表示ズレの都合で
          // UTC 00:00にほぼ乗らず（不変条件/地雷を参照）、「00:00の時だけ日付」という
          // 判定だと日付がほぼ一生出てこず「02:00 06:00」等の時刻だけが延々と繰り返し
          // 表示されてしまう。この粒度では時刻より日付の方が有用なので、常に日付を出す
          return timeframeSecRef.current >= 14400
            ? `${yy} ${M}/${D}`
            : d.getUTCHours() === 0 && d.getUTCMinutes() === 0
              ? `${yy} ${M}/${D}`
              : `${hh}:${mm}`;
        },
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });

    // lightweight-chartsは後から追加したSeriesほど上に描かれる仕様のため、ロウソク足
    // （addCandlestickSeries）はEMA/SMA/BB/雲より後で追加すること——これらが重なった時に
    // ロウソク足が上に見えるようにしたいという要望を受けた。以前は先頭で追加しており、
    // インジケーターがロウソク足の実体・ヒゲを覆い隠して見づらいことがあった
    const emaSeries = chart.addLineSeries({
      color: EMA_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const smaSeries = chart.addLineSeries({
      color: SMA_COLOR,
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
    const bbBasisSeries  = chart.addLineSeries({ ...bbLineOptions, color: BB_BASIS_COLOR, lineStyle: LineStyle.Solid });
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
    const senkouASeries = chart.addLineSeries({ ...cloudLineOptions, color: CLOUD_A_COLOR });
    const senkouBSeries = chart.addLineSeries({ ...cloudLineOptions, color: CLOUD_B_COLOR });

    const seriesOptions: Partial<CandlestickSeriesOptions> = {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    };
    const series = chart.addCandlestickSeries(seriesOptions);

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
      useTraderStore.getState().setCrosshair(mySourceIdRef.current, (param.time as number | undefined) ?? null);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    // マウスカーソル位置の日付（lightweight-charts組み込みの、日付軸欄に出る
    // ハイライト表示）と区切り線・垂直線の自前日付ラベル（DOM、これらの方が後から常に
    // 前面に重なる）が同じ位置で衝突すると、カーソル側の日付が隠れて読めなくなって
    // いた。カーソル位置に近いラベルは一時的に隠し、カーソル側を優先する
    // （線自体は隠さない、ラベルだけ）。sourceEventの有無を問わず全ての
    // crosshair移動（他パネルからの同期含む）で反応させる
    const hideLabelNearCursor = (els: Iterable<HTMLDivElement>, cx: number | undefined) => {
      for (const el of els) {
        const label = el.lastChild as HTMLDivElement | undefined;
        if (!label || label.style.display === 'none') continue;
        const elLeft = parseFloat(el.style.left || '');
        label.style.visibility = cx !== undefined && !Number.isNaN(elLeft) && Math.abs(elLeft - cx) < 28
          ? 'hidden'
          : 'visible';
      }
    };
    const onCrosshairMoveForSeparatorLabels: Parameters<typeof chart.subscribeCrosshairMove>[0] = param => {
      const cx = param.point?.x;
      hideLabelNearCursor(weekLineElsRef.current, cx);
      hideLabelNearCursor(vlineElsRef.current.values(), cx);
    };
    chart.subscribeCrosshairMove(onCrosshairMoveForSeparatorLabels);

    // 時刻→X座標変換。timeToCoordinateは足の時刻と完全一致しないとnullを返すため、
    // 時間軸切替（例: 15m→4H）で描画済みの水平線/四角形の時刻が新しい足のグリッドと
    // 一致せず、見えなくなってしまう問題への対策。表示範囲内なら前後の実足の座標を
    // 線形補間し、範囲外なら最初/最後の足にクランプする
    const timeToX = (t: number): number | null => {
      if (!chartRef.current) return null;
      const ts = chartRef.current.timeScale();
      const exact = ts.timeToCoordinate(t as Time);
      if (exact !== null) return exact;
      // メインはcandles.slice(0,cursor+1)と同じ内容、非メインは自前集計＋未来隠しクリップ
      // 済みのdisplayCandlesRefをそのまま使う（このインスタンスが実際に表示している足）
      const visible = displayCandlesRef.current;
      if (visible.length === 0) return null;
      if (t <= visible[0].time) return ts.timeToCoordinate(visible[0].time as Time);
      // 開示済みの最後の足より先（未来）の時刻。最後の足にクランプすると、未来に伸びた
      // トレンドライン等の端点が最後の足の位置に潰れて角度が変わってしまう（時間足ごとに
      // 線の見え方が変わる原因になっていた）。全期間の足（メインはcandles全体、非メインは
      // 自前集計の全期間）上での位置をバー番号で求め、実在しない先はtimeframe間隔で外挿する
      const revealedIdx = Math.min(visible.length - 1, effectiveCursorRef.current);
      const revealedLast = visible[revealedIdx];
      if (revealedLast && t > revealedLast.time) {
        const full = isMainRef.current ? visible : nonMainCandlesRef.current;
        if (full.length === 0) return ts.timeToCoordinate(revealedLast.time as Time);
        let lo = 0, hi = full.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (full[mid].time <= t) lo = mid; else hi = mid - 1;
        }
        let logical: number;
        if (lo >= full.length - 1) logical = full.length - 1 + (t - full[full.length - 1].time) / timeframeSecRef.current;
        else logical = lo + (t - full[lo].time) / (full[lo + 1].time - full[lo].time);
        // logicalToCoordinateは小数のindexだと0を返す仕様なので、整数2点の座標から補間する
        const base = Math.floor(logical);
        const xa = ts.logicalToCoordinate(base as Logical);
        const xb = ts.logicalToCoordinate((base + 1) as Logical);
        if (xa === null || xb === null) return null;
        return xa + (logical - base) * (xb - xa);
      }
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

    // 垂直線専用: timeToXは足と足の間の時刻を線形補間してしまうため、他時間足のパネルで
    // 見た時（例: 1Hで引いた線を4Hパネルで表示）に足と足の隙間を指してしまっていた
    // （実際に指摘を受けて判明）。その時刻を含むロウソク足（floor側の足）自体の位置を
    // 指すようスナップする。線を引いたパネル自身（同じ時間足）では元々ぴったり一致するため
    // 影響しない
    const timeToXSnapped = (t: number): number | null => {
      if (!chartRef.current) return null;
      const ts = chartRef.current.timeScale();
      const exact = ts.timeToCoordinate(t as Time);
      if (exact !== null) return exact;
      const visible = displayCandlesRef.current;
      if (visible.length === 0) return null;
      if (t <= visible[0].time) return ts.timeToCoordinate(visible[0].time as Time);
      if (t >= visible[visible.length - 1].time) return ts.timeToCoordinate(visible[visible.length - 1].time as Time);
      let lo = 0, hi = visible.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (visible[mid].time <= t) lo = mid; else hi = mid;
      }
      return ts.timeToCoordinate(visible[lo].time as Time);
    };

    // hiddenTimeframesを持つ全描画要素（水平線・垂直線・四角形・トレンドライン・平行チャネル・
    // 矢印・ブラシ・テキスト）について、
    // このパネルの時間足で非表示にしている図形を除いた配列を返す。描画・当たり判定・
    // 選択ハンドルは必ずstoreの生配列ではなくこれから図形を取ること——非表示の図形が最初から
    // 含まれないので、選択中の図形をfindで探す箇所も自動的に「見つからない＝ハンドルを出さない」
    // になる。以前は各ループで個別にisHiddenTimeframesVisibleAtを呼んでおり、1箇所の
    // 入れ忘れで「非表示の図形がクリックに反応する」「ハンドルだけ残る」不具合を踏んでいた。
    // syncVLines等から即時に呼ばれるため、それらより前に宣言すること（TDZ）
    const getVisibleDrawings = () => {
      const { lines, vlines, rects, trendLines, channels, arrows, brushes, texts } = useTraderStore.getState();
      const tf = timeframeSecRef.current;
      const visible = <T extends { hiddenTimeframes?: TimeframeSec[] }>(arr: T[]): T[] =>
        arr.filter(o => isHiddenTimeframesVisibleAt(o, tf));
      return {
        lines: visible(lines), vlines: visible(vlines), rects: visible(rects),
        trendLines: visible(trendLines), channels: visible(channels),
        arrows: visible(arrows), brushes: visible(brushes), texts: visible(texts),
      };
    };

    // 水平線・垂直線・雲の塗りつぶし・四角形が共通で使うロウソク足の透明抜き。以前は
    // 高値〜安値の全域を実体と同じbarSpacing幅で一律に抜いていたため、ヒゲだけの区間
    // （高値〜実体上端、実体下端〜安値）でも本体1本ぶんの幅で避けてしまい、線が必要以上に
    // 途切れて見えていた（実際に指摘を受けて判明）。実体区間はbarSpacing幅、ヒゲ区間は
    // 細い固定幅（WICK_CUTOUT_PX）に分けて抜くよう変更した。lightweight-charts自体は
    // ヒゲの実際の描画幅を設定として公開していないため、この幅はTradingView等を参考にした近似値
    const cutCandlesFromCanvas = (ctx: CanvasRenderingContext2D, w: number) => {
      if (!chartRef.current || !seriesRef.current) return;
      const series = seriesRef.current;
      const barSpacing = chartRef.current.timeScale().options().barSpacing;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      // メインは displayCandlesRef が未開示（cursorより先）の足まで含むグローバルcandlesその
      // ものなので、effectiveCursorRefで開示済みの範囲だけに絞る。絞らないと四角形・雲の塗り
      // つぶしが「まだ見えていない将来の足」の分まで見越して抜けてしまう
      // 数万本を毎回なぞらないよう、表示範囲（論理インデックス=配列インデックス）の足だけ処理する
      const dc = displayCandlesRef.current;
      const range = chartRef.current.timeScale().getVisibleLogicalRange();
      const lastIdx = Math.min(dc.length - 1, effectiveCursorRef.current);
      const fromIdx = range ? Math.max(0, Math.floor(range.from) - 1) : 0;
      const toIdx = range ? Math.min(lastIdx, Math.ceil(range.to) + 1) : lastIdx;
      for (let ci = fromIdx; ci <= toIdx; ci++) {
        const c = dc[ci];
        const cx = timeToX(c.time);
        if (cx === null || cx < -barSpacing || cx > w + barSpacing) continue;
        const yHigh = series.priceToCoordinate(c.high);
        const yLow = series.priceToCoordinate(c.low);
        const yOpen = series.priceToCoordinate(c.open);
        const yClose = series.priceToCoordinate(c.close);
        if (yHigh === null || yLow === null || yOpen === null || yClose === null) continue;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyBottom = Math.max(yOpen, yClose);
        if (bodyTop > yHigh) ctx.fillRect(cx - WICK_CUTOUT_PX / 2, yHigh, WICK_CUTOUT_PX, bodyTop - yHigh);
        if (yLow > bodyBottom) ctx.fillRect(cx - WICK_CUTOUT_PX / 2, bodyBottom, WICK_CUTOUT_PX, yLow - bodyBottom);
        ctx.fillRect(cx - barSpacing / 2, bodyTop, barSpacing, Math.max(bodyBottom - bodyTop, 1));
      }
      ctx.restore();
    };

    // ── 雲（先行スパンA/B）の塗りつぶし（chart/cloudOverlay.ts）。cutCandlesFromCanvasを
    // 引数で渡すため、その定義より後で生成すること（TDZ）
    const syncCloud = createSyncCloud({
      chartRef, seriesRef, canvasRef: cloudCanvasRef, displayCandlesRef, cloudDataRef, cutCandlesFromCanvas,
    });
    syncCloudRef.current = syncCloud;

    // 水平線・垂直線の描画（線本体は専用canvas、垂直線の日付ラベルと選択ハンドルのみDOM）。
    // ドラッグ中は store を経由せずここだけ書き換えて即座に再描画するプレビュー用
    // （他の描画要素と同じ作法）。syncVLinesより前で宣言すること——TDZ、平行チャネルで実際に踏んだ
    let vlineDragPreviewX: { id: number; x: number } | null = null;
    let hlineDragPreviewPrice: { id: number; price: number } | null = null;
    const {
      sync: syncVLines, drawVLineCanvas, drawHLineCanvas,
    } = createLinesOverlay({
      chartRef, seriesRef, overlayRef, container, vlineCanvasRef, hlineCanvasRef,
      vlineElsRef, lineHandleElRef,
      getVLineDragPreview: () => vlineDragPreviewX, getHLineDragPreview: () => hlineDragPreviewPrice,
      timeToXSnapped, getVisibleDrawings, cutCandlesFromCanvas,
    });
    drawHLineCanvasRef.current = drawHLineCanvas;
    syncVLinesRef.current = syncVLines;
    syncVLines();

    // ── 四角形（chart/rectsOverlay.ts。枠線は専用canvas、選択中のリサイズハンドルのみDOM） ──
    // ドラッグ中（コーナー/辺リサイズ・移動・新規描画）はstoreを経由せずここだけ書き換えて
    // 即座に再描画するプレビュー用（storeのコミットはmouseupまで行わない、
    // トレンドライン等の他の描画要素と同じ作法）。syncRectsより前で宣言すること（TDZ）
    let rectDragPreviewPx: { id: number; x1: number; y1: number; x2: number; y2: number } | null = null;
    let newRectDraftPx: { x1: number; y1: number; x2: number; y2: number } | null = null;
    const { sync: syncRects, positionRectHandles } = createRectsOverlay({
      chartRef, seriesRef, canvasRef: rectCanvasRef, handleOverlayRef: rectHandleOverlayRef, handleElsRef: rectHandleElsRef,
      timeToX, getVisibleDrawings, cutCandlesFromCanvas,
      getDragPreview: () => rectDragPreviewPx, getNewDraft: () => newRectDraftPx,
    });
    syncRectsRef.current = syncRects;
    syncRects();

    // ── トレンドライン（chart/trendLinesOverlay.ts、2点を結ぶ斜めの線分） ──────
    // ドラッグ中（端点リサイズ・平行移動）は、storeを経由せずここだけ書き換えて即座に
    // 再描画するプレビュー用（storeのコミットはmouseupまで行わない、他の描画要素と同じ作法）
    let trendDragPreview: { id: number; time1: number; price1: number; time2: number; price2: number } | null = null;
    // 新規描画中（まだstoreに存在しない）のプレビューはピクセル座標のみで持つ
    let newTrendDraft: { x1: number; y1: number; x2: number; y2: number } | null = null;
    const syncTrendLines = createSyncTrendLines({
      chartRef, seriesRef, canvasRef: trendCanvasRef, timeToX, getVisibleDrawings,
      getDragPreview: () => trendDragPreview, getNewDraft: () => newTrendDraft,
    });
    syncTrendLinesRef.current = syncTrendLines;
    syncTrendLines();

    // ── 平行チャネル（chart/channelsOverlay.ts、基準線＋価格オフセットした2本目の平行線） ──
    // ドラッグ中（端点リサイズ・平行移動・オフセット調整）は、storeを経由せずここだけ
    // 書き換えて即座に再描画するプレビュー用（トレンドラインと同じ作法）
    let channelDragPreview: { id: number; time1: number; price1: number; time2: number; price2: number; offset: number } | null = null;
    // 新規描画中（まだstoreに存在しない）のプレビューはピクセル座標のみで持つ
    let newChannelDraft: { x1: number; y1: number; x2: number; y2: number } | null = null;
    // 基準線が確定し、オフセットを決めるクリック待ちの状態（このモードの間もisDrawingChannelは
    // ONのまま維持し、ツールバーのハイライトを保つ）
    let channelAwaitingOffset: { time1: number; price1: number; time2: number; price2: number } | null = null;
    let channelOffsetPreview: number | null = null; // 待機中のマウス移動プレビュー（価格差、クリック確定前）

    const syncChannels = createSyncChannels({
      chartRef, seriesRef, canvasRef: channelCanvasRef, timeToX, getVisibleDrawings,
      getDragPreview: () => channelDragPreview, getNewDraft: () => newChannelDraft,
      getAwaitingOffset: () => channelAwaitingOffset, getOffsetPreview: () => channelOffsetPreview,
    });
    syncChannelsRef.current = syncChannels;
    syncChannels();
    cancelChannelAwaitRef.current = () => {
      channelAwaitingOffset = null;
      channelOffsetPreview = null;
      syncChannels();
    };

    // ── 矢印（chart/arrowsOverlay.ts、特定の足を指し示す） ─────────────────
    let arrowDragPreview: { id: number; time1: number; price1: number; time2: number; price2: number } | null = null;
    let newArrowDraft: { x1: number; y1: number; x2: number; y2: number } | null = null;
    const syncArrows = createSyncArrows({
      chartRef, seriesRef, canvasRef: arrowCanvasRef, timeToX, getVisibleDrawings,
      getDragPreview: () => arrowDragPreview, getNewDraft: () => newArrowDraft,
    });
    syncArrowsRef.current = syncArrows;
    syncArrows();

    // ── ブラシ（chart/brushesOverlay.ts、フリーハンド） ─────────────────────
    // ドラッグ中の平行移動プレビュー（storeを経由しない、他の描画要素と同じ作法）
    let brushDragPreview: { id: number; points: { time: number; price: number }[] } | null = null;
    // 新規描画中（まだstoreに存在しない）の軌跡。ドラッグしている間だけ生きる
    let newBrushDraft: { time: number; price: number }[] | null = null;
    const syncBrushes = createSyncBrushes({
      chartRef, seriesRef, canvasRef: brushCanvasRef, timeToX, getVisibleDrawings,
      getDragPreview: () => brushDragPreview, getNewDraft: () => newBrushDraft,
    });
    syncBrushesRef.current = syncBrushes;
    syncBrushes();

    // ── テキストの直接編集（chart/textEditing.ts）。syncTextsが編集中IDを読むため、その生成より前に作る
    const { getEditingTextId, beginEditExistingText, beginNewTextEdit } = createTextEditor({ textElsRef, syncTextsRef });

    // ── テキストボックスの位置をDOMに反映（chart/textsOverlay.ts） ────────
    const syncTexts = createSyncTexts({
      chartRef, seriesRef, overlayRef: textOverlayRef, elsRef: textElsRef, timeToX, getVisibleDrawings,
      getEditingTextId,
    });
    syncTextsRef.current = syncTexts;
    syncTexts();

    // 週区切り線・セッション帯のDOMオーバーレイ（実装は./chart/配下。描画ツールと絡まない
    // 表示専用の要素なので、共有状態をrefで受け取る関数として切り出してある）
    const syncWeekLines = createSyncWeekLines({
      chartRef, overlayRef: weekOverlayRef, boundariesRef: weekBoundariesRef, elsRef: weekLineElsRef, displayCandlesRef, effectiveCursorRef,
    });
    syncWeekLinesRef.current = syncWeekLines;
    syncWeekLines();

    const syncSessions = createSyncSessions({
      chartRef, overlayRef: sessionOverlayRef, bandsRef: sessionBandsRef, elsRef: sessionElsRef,
      markerElRef: sessionMarkerElRef, displayCandlesRef, effectiveCursorRef, timeframeSecRef, timeToX,
    });
    syncSessionsRef.current = syncSessions;
    syncSessions();

    // 売買マーカー行（実装は./chart/tradeMarkersOverlay.ts）
    const syncTradeMarkers = createSyncTradeMarkers({
      chartRef, seriesRef, overlayRef: tradeMarkerOverlayRef,
      elsRef: tradeMarkerElsRef, lineElsRef: tradeMarkerLineElsRef, timeframeSecRef,
      // 足と足の間へ補間せず、その時刻を含む足の位置に出す（上位足で足の無い所を指さないように）
      timeToX: timeToXSnapped,
    });
    syncTradeMarkersRef.current = syncTradeMarkers;
    syncTradeMarkers();

    // ── 発注パネルの draft 価格からリスクリワードをプレビュー（chart/rrPreviewOverlay.ts） ──
    const updateRRPreview = createUpdateRRPreview({
      chartRef, seriesRef, overlayRef: rrOverlayRef, tpBoxRef: rrTpBoxRef, slBoxRef: rrSlBoxRef, labelRef: rrLabelRef,
    });
    updateRRPreviewRef.current = updateRRPreview;
    updateRRPreview();

    // 全期間スクラバー（実装は./chart/scrubber.ts。マウスイベントの登録もそこで行い、
    // effectのcleanupでdispose()して解除する）
    const scrubber = createScrubber({ chartRef, trackRef: scrubberTrackRef, thumbRef: scrubberThumbRef });
    const syncScrubber = scrubber.sync;
    syncScrubberRef.current = syncScrubber;
    syncScrubber();

    // 表示中のズーム/スケールを時間軸ごとに記憶（連続発火するため軽くデバウンス）
    const scheduleSaveView = () => {
      if (saveViewTimerRef.current !== undefined) window.clearTimeout(saveViewTimerRef.current);
      saveViewTimerRef.current = window.setTimeout(() => {
        if (!chartRef.current) return;
        const range = chartRef.current.timeScale().getVisibleLogicalRange();
        if (!range) return;
        // このパネル自身の時間軸・本数で保存する（非メインパネルにはグローバルcursorが
        // 意味を持たないため。メインはdisplayCandles.length===cursor+1で従来と同じ結果になる）
        const totalBars = displayCandlesRef.current.length;
        if (totalBars <= 0) return;
        saveChartView(timeframeSecRef.current, { span: range.to - range.from, barsFromRight: totalBars - range.to });
      }, 400);
    };

    // 座標変換（表示範囲・縦スケール・サイズ）に依存する描画を全部描き直す。表示範囲変更・
    // マウス移動時の再同期・リサイズの各所から呼ぶ（場所ごとに手書きすると一部の図形が漏れる）
    const syncDrawingOverlays = () => {
      syncVLines(); syncRects(); syncTrendLines(); syncChannels(); syncArrows(); syncBrushes(); syncTexts();
      syncWeekLines(); syncSessions(); syncTradeMarkers(); syncCloud();
    };

    const onRangeChange = () => {
      syncDrawingOverlays(); updateRRPreview(); syncScrubber(); scheduleSaveView();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    // 「最新足に固定」の継続追従（followLatest）は4パネル共通のグローバルフラグだが、
    // 個々のパネルの追従アンカー（followAnchorRef、下の方で定義）はパネルごとに独立している。
    // ユーザーが手動でパン/ズームした「そのパネルだけ」、その操作後の位置を新しい固定位置として
    // 引き継ぎたい（他のパネルは無関係のまま追従を続けてほしい）——という要望を受けて、
    // グローバルなfollowLatestは触らず、このパネル自身のfollowAnchorRefだけを操作後の
    // 可視範囲で上書きする方式にした（以前はここでfollowLatestをfalseにして全パネルの
    // 追従を止めていたが、1パネルの操作で他3パネルまで止まってしまうのは意図と異なっていた）。
    // 当初はvisibleLogicalRangeChangeイベントで「プログラム側の変更かどうか」を判定しようと
    // したが、series.update()で足を1本追加するだけでも（明示的にsetVisibleLogicalRangeを
    // 呼んでいなくても）このイベントが飛ぶため、範囲変更イベントではなくホイール（ズーム）と
    // ドラッグ（パン）というユーザー操作そのものを直接検知する方式を採る
    // 非メインパネルは「最新足に固定」トグルに関わらず常時追従がデフォルト（下の
    // followLatest継続追従effect参照）。メインは従来通りfollowLatestトグル依存のまま
    const isFollowActiveNow = () => (isMainRef.current ? useTraderStore.getState().followLatest : true);
    const captureFollowAnchorFromCurrentView = () => {
      if (!isFollowActiveNow() || !chartRef.current) return;
      const lastIdx = effectiveCursorRef.current;
      if (lastIdx < 0) return;
      const range = chartRef.current.timeScale().getVisibleLogicalRange();
      if (!range || range.to <= range.from) return;
      followAnchorRef.current = { span: range.to - range.from, offset: range.to - lastIdx };
    };
    // ジャンプ機能のeffect（この巨大effectの外、jumpSyncSignal依存の別effect）からも
    // 呼べるようにrefへ公開する（他のsyncXRefと同じパターン）
    captureFollowAnchorRef.current = captureFollowAnchorFromCurrentView;
    container.addEventListener('wheel', captureFollowAnchorFromCurrentView, { passive: true });
    let dragStartXY: { x: number; y: number } | null = null;
    let isDraggingForFollow = false;
    const onContainerMouseDownForFollow = (e: MouseEvent) => { dragStartXY = { x: e.clientX, y: e.clientY }; isDraggingForFollow = false; };
    const onWindowMouseMoveForFollow = (e: MouseEvent) => {
      if (!dragStartXY || isDraggingForFollow) return;
      if (Math.hypot(e.clientX - dragStartXY.x, e.clientY - dragStartXY.y) >= CLICK_TOLERANCE_PX) {
        isDraggingForFollow = true;
      }
    };
    // ドラッグ終了（mouseup）時点の可視範囲を確定値としてアンカーに反映する。
    // ドラッグ中（しきい値超え検知の瞬間）に読むと途中経過の座標を拾ってしまうため、
    // 必ずドラッグが終わった後の最終位置で読み直す
    const onWindowMouseUpForFollow = () => {
      if (isDraggingForFollow) captureFollowAnchorFromCurrentView();
      dragStartXY = null;
      isDraggingForFollow = false;
    };
    container.addEventListener('mousedown', onContainerMouseDownForFollow);
    window.addEventListener('mousemove', onWindowMouseMoveForFollow);
    window.addEventListener('mouseup', onWindowMouseUpForFollow);

    // 価格軸のドラッグ（縦方向のスケール変更）だけは時間軸の可視範囲が変わらないため、
    // onRangeChange（timeScale.subscribeVisibleLogicalRangeChange）が発火せず、水平線・
    // 垂直線・四角形・トレンドライン・平行チャネル・雲など全てのcanvas自前描画が
    // 追従しないままになっていた（実際に「時間軸には追従するのに価格軸だけ追従しない」
    // という指摘を受けて判明）。lightweight-charts自体は価格軸変更を購読できる
    // イベントを公開していないため、コンテナ内でのマウスドラッグ中は常にonRangeChangeと
    // 同じ再同期をかけることで代用する（通常の時間軸パン/ズーム中は二重に呼ばれるだけで
    // 実害はない）
    let isMouseDownInContainerForPriceScale = false;
    const onContainerMouseDownForPriceScale = () => { isMouseDownInContainerForPriceScale = true; };
    const onWindowMouseMoveForPriceScale = () => {
      if (isMouseDownInContainerForPriceScale) onRangeChange();
    };
    const onWindowMouseUpForPriceScale = () => { isMouseDownInContainerForPriceScale = false; };
    container.addEventListener('mousedown', onContainerMouseDownForPriceScale);
    window.addEventListener('mousemove', onWindowMouseMoveForPriceScale);
    window.addEventListener('mouseup', onWindowMouseUpForPriceScale);
    // マウスホイールでの価格軸ズームも同じ理由でonRangeChangeが発火しないため、
    // wheelイベントでも同様に再同期する
    container.addEventListener('wheel', onRangeChange, { passive: true });

    // クリックで水平線 / 垂直線を配置、または 指値・TP・SL の価格を取得（各モード中のみ）
    chart.subscribeClick(param => {
      // Phase 2: 非メインパネルでも水平線/垂直線/テキスト配置・pickTargetでの価格指定を許可する
      const { isDrawingLine: drawingH, isDrawingVLine: drawingV, isDrawingText: drawingT, pickTarget, addLine, addVLine, pickPrice, isJumpSync: jumpSync, jumpSyncTo } = useTraderStore.getState();
      if (!param.point || !seriesRef.current) return;

      // 他時間足へジャンプ: クリックした足の時刻をそのまま使う（lightweight-chartsが
      // 実データ点上のクリックにだけparam.timeを埋めてくれるので、磁石/座標変換は不要）
      if (jumpSync) {
        if (param.time !== undefined) jumpSyncTo(mySourceIdRef.current, param.time as number);
        return;
      }

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
        return;
      }
      if (drawingT && chartRef.current) {
        const time = chartRef.current.timeScale().coordinateToTime(param.point.x);
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (time === null || price === null) return;
        // 水平線・垂直線と同じく1回配置したらツールは解除する（addText自身が行う）。
        // 配置と同時にその場でcontentEditableの入力ボックスに切り替え、直接入力させる
        beginNewTextEdit(time as number, price);
        return;
      }

    });

    // 価格軸のドラッグによる縦スケール変更はlightweight-charts側の内部処理で、
    // それを教えてくれるイベントが無い。そのためドラッグ操作中でなくても、マウスが
    // 動くたびに（rAFで間引きながら）座標に依存する描画を全部再計算することで
    // 追従させる（本来の座標変換はスケールに依存するので、再計算自体は毎回必要な処理）
    let overlayResyncScheduled = false;

    // 描画物・価格ラインの当たり判定（chart/hitTest.ts）と、マウス座標→時刻・価格の変換（chart/coordinates.ts）
    const {
      findDraftNear, findHLineNear, findPriceTargetNear, findVLineNear,
      findRectCornerNear, findRectEdgeNear, findRectBorderNear,
      findTrendEndpointNear, findTrendLineNear,
      findChannelEndpointNear, findChannelBaseNear, findChannelOffsetLineNear,
      findArrowEndpointNear, findArrowNear,
      findBrushVertexNear, findBrushCircleCornerNear, findBrushNear, findTextNear,
    } = createHitTests({ chartRef, seriesRef, textElsRef, getVisibleDrawings, timeToX, timeToXSnapped });
    const { pixelToTime, pixelToContinuousTime, magnetSnap } = createCoordinateHelpers({ chartRef, seriesRef, displayCandlesRef, timeToX });

    // 価格ラインのドラッグ中にチャート側のライン（createPriceLine）を直接動かすためのマップ
    const priceLineMapFor = (kind: DragTarget['kind']): Map<number, IPriceLine> => {
      if (kind === 'hline') return priceLineMapRef.current;
      if (kind === 'order') return orderLineMapRef.current;
      if (kind === 'tp') return tpLineMapRef.current;
      if (kind === 'sl') return slLineMapRef.current;
      if (kind === 'orderTp') return orderTpLineMapRef.current;
      return orderSlLineMapRef.current;
    };

    // ── マウス操作の振り分け（chart/drag.ts） ─────────────────────────────
    // 図形ごとのツールがmousedownでDragSessionを作り、ドラッグ中のmousemove/mouseupは
    // そのセッションだけが受け取る。まだこの形に移していない図形は下のdragging系の変数で処理する
    let activeSession: DragSession | null = null;
    const vlineTool = createVLineTool({
      chart, container, findVLineNear, vlineElsRef, lineHandleElRef,
      setDragPreview: p => { vlineDragPreviewX = p; }, drawVLineCanvas,
    });
    const twoPointCommon = { chart, container, seriesRef, displayCandlesRef, magnetSnap, pixelToTime, timeToX };
    const trendTool = createTwoPointTool({
      ...twoPointCommon, selectionKind: 'trend',
      list: () => useTraderStore.getState().trendLines,
      add: (t1, p1, t2, p2) => useTraderStore.getState().addTrendLine(t1, p1, t2, p2),
      update: (id, patch) => useTraderStore.getState().updateTrendLine(id, patch),
      findEndpoint: (x, y) => { const h = findTrendEndpointNear(x, y); return h && { id: h.trendId, timeField: h.timeField, priceField: h.priceField }; },
      findBody: findTrendLineNear,
      setDragPreview: p => { trendDragPreview = p; }, setNewDraft: d => { newTrendDraft = d; }, sync: syncTrendLines,
    });
    // 矢印はShiftで水平/垂直に強制できる（新規描画・端点ドラッグとも）
    const arrowTool = createTwoPointTool({
      ...twoPointCommon, selectionKind: 'arrow', shiftConstrains: true,
      list: () => useTraderStore.getState().arrows,
      add: (t1, p1, t2, p2) => useTraderStore.getState().addArrow(t1, p1, t2, p2),
      update: (id, patch) => useTraderStore.getState().updateArrow(id, patch),
      findEndpoint: (x, y) => { const h = findArrowEndpointNear(x, y); return h && { id: h.arrowId, timeField: h.timeField, priceField: h.priceField }; },
      findBody: findArrowNear,
      setDragPreview: p => { arrowDragPreview = p; }, setNewDraft: d => { newArrowDraft = d; }, sync: syncArrows,
    });
    const channelTool = createChannelTool({
      chart, container, seriesRef, displayCandlesRef, magnetSnap, pixelToTime, timeToX,
      findEndpoint: (x, y) => { const h = findChannelEndpointNear(x, y); return h && { id: h.channelId, timeField: h.timeField, priceField: h.priceField }; },
      findBase: findChannelBaseNear, findOffsetLine: findChannelOffsetLineNear,
      setDragPreview: p => { channelDragPreview = p; }, setNewDraft: d => { newChannelDraft = d; },
      getAwaitingOffset: () => channelAwaitingOffset, setAwaitingOffset: b => { channelAwaitingOffset = b; },
      setOffsetPreview: o => { channelOffsetPreview = o; }, sync: syncChannels,
    });
    const rectTool = createRectTool({
      chart, container, seriesRef, displayCandlesRef, magnetSnap, pixelToTime, timeToX,
      findCorner: findRectCornerNear, findEdge: findRectEdgeNear, findBorder: findRectBorderNear,
      setDragPreview: p => { rectDragPreviewPx = p; }, setNewDraft: d => { newRectDraftPx = d; },
      sync: syncRects, positionRectHandles,
    });
    const brushTool = createBrushTool({
      chart, container, seriesRef, magnetSnap, pixelToContinuousTime, timeToX,
      findVertex: findBrushVertexNear, findCircleCorner: findBrushCircleCornerNear, findBody: findBrushNear,
      setDragPreview: p => { brushDragPreview = p; }, setNewDraft: d => { newBrushDraft = d; }, sync: syncBrushes,
    });
    const { draftTool, priceTargetTool, hlineTool } = createPriceLineTools({
      chart, container, seriesRef, findDraftNear, findPriceTargetNear, findHLineNear, priceLineMapFor,
      lineHandleElRef, setHLineDragPreview: p => { hlineDragPreviewPrice = p; }, drawHLineCanvas, magnetSnap,
    });
    const textMoveTool = createTextMoveTool({ chart, container, seriesRef, textElsRef, findTextNear, pixelToTime });
    const measureTool = createMeasureTool({
      chart, seriesRef, overlayRef: measureOverlayRef, boxRef: measureBoxRef, midLineRef: measureMidLineRef,
      labelRef: measureLabelRef, displayCandlesRef,
    });
    // 既存の図形・ラインをつかむ時の優先順位（mousedownとホバー時のカーソルで共通）:
    // 下書き→注文/TP/SL→垂直線→矢印（最前面に描かれるため他の図形より先）→四角形→トレンドライン→
    // 平行チャネル→ブラシ→テキスト→水平線（画面全幅で当たるため最後。四角形等の編集を優先する）
    const editTools = combineTools([
      draftTool, priceTargetTool, vlineTool, arrowTool.editTool, rectTool.editTool, trendTool.editTool,
      channelTool.editTool, brushTool.editTool, textMoveTool, hlineTool,
    ]);


    // チャート本体をつかんでパンしている間true（カーソルを「つかんでいる手」にする）
    let panGrabbing = false;
    const onMouseDown = (e: MouseEvent) => {
      // Phase 4: 4画面時、Delete/Undo/コピペ等のキーボードショートカットを「最後に
      // マウス操作した1枠」だけに効かせるための目印。クリックの種類を問わず常に更新する
      useTraderStore.getState().setActivePanelSlot(slotRef.current);
      // テキストの直接編集中（contentEditable）は、その中でのクリックはカーソル移動・
      // 範囲選択などブラウザ標準のテキスト編集操作に委ね、こちらの図形ドラッグ判定は行わない
      // （行うと編集中のテキストボックスが意図せず動いてしまう）
      if (getEditingTextId() !== null) return;
      // Phase 2: 非メインパネルでも同じドラッグ/当たり判定を動かす。ただし「ドラッグでない
      // 単純クリックでメイン昇格」という非メイン専用の挙動も残す必要があるため、この関数の
      // 末尾（何にもヒットしなかった＝空白クリックの分岐）でだけ始点を記録する
      // （最初にnullへ戻しておき、以降のどこかの分岐で早期returnした＝実際に何か操作した
      // 場合は昇格候補にしない。onMouseUp側で移動量判定して実際に昇格させる）
      nonMainMouseDownPosRef.current = null;
      // 右クリック（コンテキストメニュー）では描画・選択・ドラッグを一切始めない
      // （描画ツール選択中なら図形の描画が始まり、図形上ならドラッグ状態に入ってしまう）
      if (e.button === 2) return;
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, isDrawingRect: isR, isDrawingTrendLine: isTL, isDrawingChannel: isCh, isDrawingArrow: isAr, isDrawingBrush: isB, isDrawingText: dT, pickTarget: pick, isJumpSync: jumpSync } = useTraderStore.getState();
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // ホイールクリック（中央ボタン）ドラッグは、ものさしツールを選択していなくても
      // 常に計測に使える。ブラウザ標準のオートスクロールカーソルは無効化する
      if (e.button === 1) {
        e.preventDefault();
        const session = measureTool.start(x, y);
        if (session) activeSession = session;
        return;
      }

      if (pick !== null) return;
      // 他時間足ジャンプツールもsubscribeClick側で処理するため、上のpickTargetと同じ理由で
      // ここで早期returnする（この関数のヒット判定チェーンへ落として二重に反応させない）
      if (jumpSync) return;
      // 水平線・垂直線・テキストの新規配置はこの関数の当たり判定チェーンではなく
      // chart.subscribeClick側で処理される。ここで早期returnしないと、配置後に
      // どのヒットテストにも当たらず末尾の「空白クリック」分岐へ落ちてしまい、
      // 非メインパネルで単に線を置いただけなのに同時にメイン昇格まで起きてしまう
      // （subscribeClickは1回のクリックで別途独立して発火するため、両方が競合して動く）
      if (dH || dV || dT) return;

      if (isR) {
        const session = rectTool.startDraw(x, y);
        if (session) activeSession = session;
        return;
      }

      if (isTL) {
        const session = trendTool.startDraw(x, y);
        if (session) activeSession = session;
        return;
      }

      if (isCh) {
        const session = channelTool.startDraw(x, y);
        if (session) activeSession = session;
        return;
      }

      if (isAr) {
        const session = arrowTool.startDraw(x, y);
        if (session) activeSession = session;
        return;
      }

      if (isB) {
        const session = brushTool.startDraw(x, y);
        if (session) activeSession = session;
        return;
      }

      if (isM) {
        const session = measureTool.start(x, y);
        if (session) activeSession = session;
        return;
      }

      // 既存の図形・ラインをつかむ（優先順位はeditToolsの並び順）
      const started = editTools.tryStartEdit(x, y);
      if (started !== null) {
        if (started !== CONSUMED) activeSession = started;
        return;
      }

      const { selected: currentSelected } = useTraderStore.getState();
      if (currentSelected !== null) {
        // 図形の外（余白）をクリックしたら選択解除する（TradingView等と同じ挙動）
        useTraderStore.getState().selectLine(null);
      }
      // 何にもヒットしなかった＝チャート本体のパン（つかんで移動）の開始。プロット領域内
      // （価格軸・日付軸のスケール操作は除く）のドラッグ中だけ「つかんでいる手」のカーソルにする
      if (e.button === 0) {
        const r = container.getBoundingClientRect();
        const ts = chart.timeScale();
        if (e.clientX - r.left < ts.width() && e.clientY - r.top < r.height - ts.height()) {
          panGrabbing = true;
          container.style.cursor = 'grabbing';
        }
      }
      // 非メインで、描画ツールも無く、既存図形にもヒットしなかった＝空白クリックの候補。
      // ドラッグでない単純クリックだった場合のみonMouseUp側でメインへ昇格させる
      if (!isMainRef.current) {
        nonMainMouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    // Shiftの押下/解除はマウスを動かさないとmoveに伝わらないため、ドラッグ中はキー操作でも
    // 直近のマウス位置でmoveを呼び直す（Shiftで水平拘束等がその場で効く）
    let lastMouse: { clientX: number; clientY: number } | null = null;
    const onShiftKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.repeat || !activeSession || !lastMouse) return;
      const rect = container.getBoundingClientRect();
      const synthetic = new MouseEvent('mousemove', { clientX: lastMouse.clientX, clientY: lastMouse.clientY, shiftKey: e.type === 'keydown' });
      activeSession.move(lastMouse.clientX - rect.left, lastMouse.clientY - rect.top, synthetic);
    };
    window.addEventListener('keydown', onShiftKey);
    window.addEventListener('keyup', onShiftKey);

    const onMouseMove = (e: MouseEvent) => {
      lastMouse = { clientX: e.clientX, clientY: e.clientY };
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (activeSession) { activeSession.move(x, y, e); return; }

      // 平行チャネルのオフセット決定待ち: ボタンを押していない移動で2本目の位置をプレビュー
      if (channelTool.moveWhileAwaitingOffset(x, y)) return;

      // 価格軸ドラッグ等、こちらで検知できないスケール変更にも追従させる（コメントは冒頭のlet宣言を参照）
      if (!overlayResyncScheduled) {
        overlayResyncScheduled = true;
        requestAnimationFrame(() => {
          overlayResyncScheduled = false;
          syncDrawingOverlays();
        });
      }

      // ドラッグ中でなければ、ライン近傍でカーソルをホバー表示に。ジャンプモード中は
      // 図形をドラッグ編集できる状態ではない（クリックは足の時刻ピックに使われる）ため、
      // 垂直線等に重なっても「ドラッグできる」ことを示す矢印カーソルは出さない
      const { isDrawingLine: dH, isDrawingVLine: dV, isMeasuring: isM, isDrawingRect: isR, isDrawingTrendLine: isTL, isDrawingChannel: isCh, isDrawingArrow: isAr, isDrawingBrush: isB, isDrawingText: dT, pickTarget: pick, isJumpSync: jumpSync } = useTraderStore.getState();
      if (!panGrabbing && !dH && !dV && !isM && !isR && !isTL && !isCh && !isAr && !isB && !dT && pick === null && !jumpSync) {
        container.style.cursor = editTools.hoverCursor(x, y) ?? 'default';
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (panGrabbing) {
        panGrabbing = false;
        container.style.cursor = 'default';
      }
      if (activeSession) {
        const rect = container.getBoundingClientRect();
        const session = activeSession;
        activeSession = null;
        session.end(e.clientX - rect.left, e.clientY - rect.top, e);
        return;
      }
      // 非メインで、ここまでのどの分岐にも該当しなかった＝何もドラッグ/操作しなかった場合のみ、
      // ドラッグでない単純クリックだったかを見てメインへ昇格させる（onMouseDown側の空白クリック
      // 判定と対になる。何か操作した場合はnonMainMouseDownPosRefがnullのままなので発火しない）
      if (!isMainRef.current) {
        const start = nonMainMouseDownPosRef.current;
        nonMainMouseDownPosRef.current = null;
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < CLICK_TOLERANCE_PX) {
          // このパネルは既にこの時間軸を自前集計済みなので、そのまま渡してDuckDBへの
          // 再クエリ待ちを省略する（渡す配列は表示用に未来をクリップする前のフル本数）
          useTraderStore.getState().promoteSlotToMain(slotRef.current, nonMainCandlesRef.current);
        }
      }
    };

    // テキストボックスのダブルクリックで内容を編集する（削除は選択してDelete/Backspaceキー、
    // 編集中に全部消してblurすると削除扱いになる（Escapeは編集前の状態に戻すだけ）
    const onDblClick = (e: MouseEvent) => {
      if (getEditingTextId() !== null) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const textId = findTextNear(x, y);
      if (textId === null) return;
      beginEditExistingText(textId);
    };

    // 垂直線を右クリックすると、その時刻へジャンプ同期（ジャンプモードの足クリックと同じ動作）
    const onContextMenu = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const id = findVLineNear(e.clientX - rect.left);
      if (id === null) return;
      const v = getVisibleDrawings().vlines.find(vl => vl.id === id);
      if (!v) return;
      e.preventDefault();
      useTraderStore.getState().jumpSyncTo(mySourceIdRef.current, v.time);
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('contextmenu', onContextMenu);
    container.addEventListener('dblclick', onDblClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Delete/Backspace・取り消し・コピー&ペースト（chart/keyboard.ts）
    const onKeyDown = createKeyboardHandler({ slotRef, chartRef, seriesRef, timeToX, pixelToTime });
    window.addEventListener('keydown', onKeyDown);

    // ウィンドウリサイズ + Controls 高さ変化（ポジション増減）+ 1画面⇔4画面のレイアウト
    // 切替（パネル自体は常時マウントされたまま、CSSでセルの大きさだけ変わる）に追従。
    // lightweight-charts は`applyOptions({width,height})`だけだとlogical range（本数
    // ベースの表示範囲）をそのまま維持する＝ローソク足1本のpx幅（barSpacing）の方が
    // 新しい幅に合わせて伸び縮みする。4画面⇔1画面の切替のように幅が大きく変わる場面では、
    // 「スケールは変えず表示範囲（本数）だけ広がってほしい」という要望があるため、
    // 幅の変化率をそのままbarSpacingの維持に使う＝表示本数をwidth比で明示的に
    // 増減させる。あわせて、本数を増減する基準を右端（最新足）ではなく「リサイズ前に
    // 画面中央にあった足」にすることで、中央の足も常に画面中央のまま保たれるようにする
    // （本数を維持するだけだと中央の足がズレる／中央を保つだけだとスケールが変わって
    // 見える、という2つの指摘を両方満たす必要があったため、この2段構えにしている）
    let prevChartWidth = 0;
    let pendingResizeRaf: number | null = null;
    const handleResize = () => {
      const ts = chart.timeScale();
      const prevRange = ts.getVisibleLogicalRange();
      const cs = displayCandlesRef.current;
      const newWidth = container.clientWidth;
      const oldWidth = prevChartWidth;
      let centerTime: number | null = null;
      if (prevRange && cs.length > 0) {
        const centerIdx = Math.max(0, Math.min(cs.length - 1, Math.round((prevRange.from + prevRange.to) / 2)));
        centerTime = cs[centerIdx].time;
      }
      chart.applyOptions({
        width:  newWidth,
        height: container.clientHeight,
      });
      if (prevRange && centerTime !== null && oldWidth > 0 && newWidth > 0 && cs.length > 0 && newWidth !== oldWidth) {
        const oldSpan = prevRange.to - prevRange.from;
        const newSpan = oldSpan * (newWidth / oldWidth);
        let lo = 0, hi = cs.length - 1, idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (cs[mid].time <= centerTime) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        ts.setVisibleLogicalRange({ from: idx - newSpan / 2, to: idx + newSpan / 2 });
      }
      prevChartWidth = newWidth;
      syncDrawingOverlays();
      updateRRPreview();
      syncScrubber();
      // timeToCoordinate/priceToCoordinateは、幅変更・setVisibleLogicalRange直後の
      // レイアウト未確定なタイミングだと稀に古い座標を返す（他のデータ更新箇所と同じ既知の
      // lightweight-charts挙動、docs/CURRENT.mdの地雷参照）。1画面⇔4画面の切替直後に
      // 雲の塗りつぶしだけズレて見え、マウスを動かす（＝再描画のきっかけになる）と直る、
      // という形で発覚した。1フレーム遅れて座標が確定した場合でも描き直せるよう、
      // 同じ同期処理をrequestAnimationFrameでもう一度呼ぶ（連続でリサイズが起きても
      // 前回分のrAFは予約し直す）
      if (pendingResizeRaf !== null) cancelAnimationFrame(pendingResizeRaf);
      pendingResizeRaf = requestAnimationFrame(() => {
        pendingResizeRaf = null;
        syncDrawingOverlays();
      });
      // フロートパネルが価格軸・時間軸に被らないよう、実測サイズをストアに反映。
      // 4画面時は全パネルほぼ同じ幅になるはずだが、書き込みはメインパネルのみに絞り
      // 複数インスタンスによる値の奪い合い（thrashing）を避ける
      if (isMainRef.current) {
        useTraderStore.getState().setChartMargins(
          chart.priceScale('right').width(),
          chart.timeScale().height(),
        );
      }
    };
    handleResizeRef.current = handleResize;
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      ro.disconnect();
      if (pendingResizeRaf !== null) cancelAnimationFrame(pendingResizeRaf);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onShiftKey);
      window.removeEventListener('keyup', onShiftKey);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      scrubber.dispose();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      container.removeEventListener('wheel', captureFollowAnchorFromCurrentView);
      container.removeEventListener('mousedown', onContainerMouseDownForFollow);
      window.removeEventListener('mousemove', onWindowMouseMoveForFollow);
      window.removeEventListener('mouseup', onWindowMouseUpForFollow);
      container.removeEventListener('mousedown', onContainerMouseDownForPriceScale);
      window.removeEventListener('mousemove', onWindowMouseMoveForPriceScale);
      window.removeEventListener('mouseup', onWindowMouseUpForPriceScale);
      container.removeEventListener('wheel', onRangeChange);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.unsubscribeCrosshairMove(onCrosshairMoveForSeparatorLabels);
      if (saveViewTimerRef.current !== undefined) window.clearTimeout(saveViewTimerRef.current);
      vlineElsRef.current.forEach(el => el.remove());
      vlineElsRef.current.clear();
      lineHandleElRef.current?.remove();
      lineHandleElRef.current = null;
      rectHandleElsRef.current.forEach(el => el.remove());
      rectHandleElsRef.current = [];
      textElsRef.current.forEach(el => el.remove());
      textElsRef.current.clear();
      weekLineElsRef.current.forEach(el => el.remove());
      weekLineElsRef.current = [];
      tradeMarkerElsRef.current.forEach(el => el.remove());
      tradeMarkerElsRef.current.clear();
      tradeMarkerLineElsRef.current.forEach(el => el.remove());
      tradeMarkerLineElsRef.current.clear();
      chart.remove();
      // chart.remove() で価格ラインも破棄されるため、次のマウント（StrictModeの
      // 二重実行や、4画面でのメインパネル切替による再マウント）で古い IPriceLine を
      // 参照し続けないようマップ側もクリアする（残すと applyOptions で
      // 「Cannot read properties of undefined (reading '_internal_state')」がクラッシュする）
      priceLineMapRef.current.clear();
      orderLineMapRef.current.clear();
      tpLineMapRef.current.clear();
      slLineMapRef.current.clear();
      positionEntryLineMapRef.current.clear();
      orderTpLineMapRef.current.clear();
      orderSlLineMapRef.current.clear();
      draftLineMapRef.current.clear();
    };
  }, []);

  // 描画・計測・価格ピッキングモード中はカーソルを crosshair に
  useEffect(() => {
    if (containerRef.current && (isDrawingLine || isDrawingVLine || isMeasuring || isDrawingRect || isDrawingTrendLine || isDrawingChannel || isDrawingArrow || isDrawingBrush || isDrawingText || pickTarget !== null || isJumpSync)) {
      containerRef.current.style.cursor = 'crosshair';
    }
  }, [isDrawingLine, isDrawingVLine, isMeasuring, isDrawingRect, isDrawingTrendLine, isDrawingChannel, isDrawingArrow, isDrawingBrush, isDrawingText, pickTarget, isJumpSync]);

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
      // 時間足ごとにON/OFFできる（hiddenTimeframes）。1Hのみ5m/15mの表示にも連動する
      const visibleLines = lines.filter(l => isHiddenTimeframesVisibleAt(l, timeframeSec));
      const nextIds = new Set(visibleLines.map(l => l.id));

      // 削除された、またはこのパネルの時間足では非表示になったラインを除去
      for (const [id, priceLine] of existing) {
        if (!nextIds.has(id)) {
          series.removePriceLine(priceLine);
          existing.delete(id);
        }
      }

      // 追加 or 更新（既存ラインは applyOptions で in-place 更新。remove+create だとドラッグ中にカクつく）
      for (const line of visibleLines) {
        const opts = {
          price: line.price,
          color: line.color,
          lineWidth: line.width,
          lineStyle: DASH_TO_STYLE[line.dash],
          axisLabelVisible: !overlaysHidden && showHLinePriceLabel,
          // 線本体は専用canvas（hlineCanvasRef、drawHLineCanvas）で自前描画するため常に隠す。
          // このcreatePriceLineは価格軸のラベル（axisLabelVisible）を出すためだけに残している
          lineVisible: false,
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
  }, [lines, selected, overlaysHidden, showHLinePriceLabel, timeframeSec]);

  // 垂直線の日付ラベルON/OFFが切り替わった時だけ再同期する（vlines自体の変化は
  // 上のhline用useEffect末尾のsyncVLinesRef経由で既にカバーされている）
  useEffect(() => {
    syncVLinesRef.current();
  }, [showVLineDateLabel]);

  // 未約定注文・ポジション（エントリー/TP/SL）・発注下書きの価格ライン（chart/usePriceLines.ts）
  usePriceLines(seriesRef, {
    orderLineMapRef, orderTpLineMapRef, orderSlLineMapRef, tpLineMapRef, slLineMapRef, positionEntryLineMapRef, draftLineMapRef,
  }, { pendingOrders, positions, orderType, draftPrice, draftTP, draftSL, candles, cursor });

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

  // トレンドラインの再描画（選択状態が変わった時も端点ハンドル表示を更新する）
  useEffect(() => {
    syncTrendLinesRef.current();
    syncChannelsRef.current();
  }, [trendLines, selected]);

  // 平行チャネルの再描画（選択状態が変わった時も端点ハンドル表示を更新する）
  useEffect(() => {
    syncChannelsRef.current();
  }, [channels, selected]);

  // ツールを切り替える等でisDrawingChannelがfalseになったら、基準線確定済み・
  // オフセット確定待ちのプレビューが残り続けないよう破棄する
  useEffect(() => {
    if (!isDrawingChannel) cancelChannelAwaitRef.current();
  }, [isDrawingChannel]);

  // 矢印の再描画（選択状態が変わった時も端点ハンドル表示を更新する）
  useEffect(() => {
    syncArrowsRef.current();
  }, [arrows, selected]);

  // ブラシの再描画（選択状態が変わった時も選択リング表示を更新する）
  useEffect(() => {
    syncBrushesRef.current();
  }, [brushes, selected]);

  // テキストボックスの再描画（選択状態が変わった時も枠表示を更新する）
  useEffect(() => {
    syncTextsRef.current();
  }, [texts, selected]);

  // 価格軸の表示精度: 読み込んだペアの価格帯に合わせる（JPYクロス=小数3桁、それ以外=小数5桁）
  const firstClose = displayCandles[0]?.close;
  useEffect(() => {
    if (firstClose === undefined) return;
    const precision = pricePrecision(firstClose);
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
    // （書き込みはメインパネルのみ。理由はhandleResize側の同種コメントを参照）
    if (!isMain) return;
    requestAnimationFrame(() => {
      if (!chartRef.current) return;
      useTraderStore.getState().setChartMargins(
        chartRef.current.priceScale('right').width(),
        chartRef.current.timeScale().height(),
      );
    });
  }, [firstClose, isMain]);

  // 区切り線・セッション帯の元データ。非メインのdisplayCandlesは再生の毎tick新しい配列になり、
  // 数十万本の再計算が毎tick走るため、全期間の集計済み足（未来分はオーバーレイ側で隠す）を使う
  const separatorSource = isMain ? displayCandles : nonMainCandles;
  // 区切り線: candles 変化時に境界を再計算（1D足は週区切り、それ以外は日区切り）、showWeekLines 変化時は表示トグル
  useEffect(() => {
    weekBoundariesRef.current = computeSeparatorBoundaries(separatorSource, timeframeSec);
    syncWeekLinesRef.current();
  }, [separatorSource, timeframeSec]);

  useEffect(() => {
    syncWeekLinesRef.current();
  }, [showWeekLines]);

  // セッション帯（東京/ロンドン/NY）: candles変化時に帯を再計算、showSessions/timeframeSec変化時は表示トグル
  useEffect(() => {
    sessionBandsRef.current = computeSessionBands(separatorSource);
    syncSessionsRef.current();
    syncTradeMarkersRef.current();
  }, [separatorSource, timeframeSec]);

  useEffect(() => {
    syncSessionsRef.current();
    syncTradeMarkersRef.current();
  }, [showSessions]);

  // メインのインジケータ（EMA/SMA/BB/雲）: 表示ON/OFFのeffectと、リプレイ更新effectが呼ぶ
  // 全再計算・差分更新の関数（chart/useIndicatorSeries.ts）
  const {
    recomputeEmaFull, updateEmaStep, recomputeSMAFull, updateSMAStep,
    recomputeBBFull, updateBBStep, recomputeCloudFull, updateCloudStep,
  } = useIndicatorSeries({
    emaSeriesRef, smaSeriesRef, bbBasisSeriesRef, bbUpper1SeriesRef, bbLower1SeriesRef,
    bbUpper2SeriesRef, bbLower2SeriesRef, senkouASeriesRef, senkouBSeriesRef,
  }, { showEMA, showSMA, showBB, showCloud, overlaysHidden, timeframeSec, cloudDataRef, syncCloudRef });

  // エントリー / 決済マーカー（トレード履歴）。専用行のDOM要素をsyncTradeMarkersRefで再同期する
  // （時間足ごとの表示/非表示はsyncTradeMarkers内でtradeMarkersVisible mapを直接読んで判定）
  useEffect(() => {
    syncTradeMarkersRef.current();
  }, [positions, closedTrades, quoteCurrency, tradeMarkersVisible]);

  // 「最新足に固定」の追従アンカー（パネルごと）。マウント時effectのパン/ホイール処理
  // （captureFollowAnchorFromCurrentView）とメインのデータ投入effectも使う
  const followAnchorRef = useRef<FollowAnchor | null>(null);
  // captureFollowAnchorFromCurrentView（マウント時effect内で定義）をジャンプ同期から呼ぶための公開先
  const captureFollowAnchorRef = useRef<() => void>(() => {});
  const applyLatestViewRef = useRef<(captureSpan: boolean) => void>(() => {});
  // 表示範囲を変えた1フレーム後に全オーバーレイを描き直す（chart/useViewRange.tsから呼ぶ）
  const syncAllOverlays = () => {
    syncCloudRef.current();
    syncVLinesRef.current();
    syncRectsRef.current();
    syncTrendLinesRef.current();
    syncChannelsRef.current();
    syncArrowsRef.current();
    syncBrushesRef.current();
    syncTextsRef.current();
    syncWeekLinesRef.current();
    syncSessionsRef.current();
    syncTradeMarkersRef.current();
  };
  const viewRangeRefs = {
    chartRef, displayCandlesRef, effectiveCursorRef, isMainRef, nonMainCandlesRef,
    followAnchorRef, applyLatestViewRef, syncAllOverlays,
  };

  // レイアウト切替時のリサイズ・「表示をリセット」・「最新足に固定」ボタン（chart/useViewRange.ts）
  useViewRangeCommands({ ...viewRangeRefs, handleResizeRef }, { chartLayout, fitSignal, scrollToLatestSignal, candles });

  // リプレイモード: カーソル変化時にデータ更新（ローソク足 + EMA200）。
  // このステップ最適化（.update()による差分更新）はグローバルcandlesが1本ずつ
  // 増える前提に依存しており、非メイン（自前集計・別時間軸）には成立しないためメイン限定
  useEffect(() => {
    if (!isMain) { wasMainForDataSyncRef.current = false; return; }
    if (!seriesRef.current || candles.length === 0) return;

    // 非メイン→メインへ昇格した直後の1回だけは、このインスタンスのprevCandlesRef/
    // prevCursorRefが未更新（初期値）のため必ずisStep=falseになり、下のelse分岐が
    // 走ってscrollToRealTime()で最新足へ強制スクロールしてしまう。昇格前まで非メイン
    // として表示していた内容と実質同じデータなのに見た目だけジャンプし、パネル切替の
    // たびに「再読み込みしたように見える」原因になっていた（実際に指摘を受けて判明）。
    // 昇格直後だけこのジャンプを避ける（データ自体のsetDataや指標の再計算は必要なので行う）
    const justPromoted = !wasMainForDataSyncRef.current;
    wasMainForDataSyncRef.current = true;

    const isStep =
      candles === prevCandlesRef.current &&
      cursor > prevCursorRef.current && cursor - prevCursorRef.current <= 30;

    if (isStep) {
      // 再生のフレーム落ち補正で複数本まとめて進むことがあるので、1本ずつ差分更新する
      for (let i = prevCursorRef.current + 1; i <= cursor; i++) {
        seriesRef.current.update(toBar(candles[i]));
        updateEmaStep(candles[i]);
        updateSMAStep(candles, i);
        updateBBStep(candles, i);
        updateCloudStep(candles, i);
      }
    } else {
      seriesRef.current.setData(candles.slice(0, cursor + 1).map(toBar));
      // 位置の決め方は「直前まで最新足に固定されていたか」で分ける。followLatestは
      // jumpToTime等が自分でfalseに戻すため判定に使えず、followAnchorRef（固定モード中に
      // 一度でも捕捉されていれば非null）を見る。捕捉済みならscrollToRealTime()（既定の
      // 右オフセット・アニメーション付き）ではなく、このパネル固有のoffset/spanをそのまま
      // 使うapplyLatestViewRefで即座に位置を確定する（1コマ戻る等で最新足の画面上の位置が
      // 既定値へジャンプせず、その1本分だけ動く）
      if (!justPromoted) {
        if (followAnchorRef.current !== null) {
          applyLatestViewRef.current(false);
        } else {
          chartRef.current?.timeScale().scrollToRealTime();
        }
      }
      recomputeEmaFull(candles, cursor);
      recomputeSMAFull(candles, cursor);
      recomputeBBFull(candles, cursor);
      recomputeCloudFull(candles, cursor);
    }
    // 価格軸ドラッグ等で autoScale が無効化されたままだと、連続再生中にローソク足が
    // 上下にはみ出ても追従しなくなるため、再生中（isPlaying）だけ毎ステップ明示的に
    // 再有効化して縦も自動追従させる。「1コマ進む」等の手動ステップでは、ユーザーが
    // ドラッグ等で調整した価格軸の拡大率・位置をそのまま維持したいという要望があるため
    // ここでは触らない（再有効化するとその都度リセットされてしまう）
    if (isPlayingRef.current) {
      chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    }
    // 可視範囲確定後に再同期（範囲変更イベントに頼らず確実に揃える）
    syncVLinesRef.current();
    syncRectsRef.current();
    syncTrendLinesRef.current();
    syncChannelsRef.current();
    syncArrowsRef.current();
    syncBrushesRef.current();
    syncTextsRef.current();
    syncWeekLinesRef.current();
    syncSessionsRef.current();
    syncTradeMarkersRef.current();

    syncScrubberRef.current();

    prevCursorRef.current  = cursor;
    prevCandlesRef.current = candles;

    // timeToCoordinate等の時刻ベース座標変換は、setData直後・ズーム/スクロール位置の
    // 復元前後などレイアウト未確定なタイミングだと稀に古い座標を返し、雲や区切り線が
    // ずれて描画されることがある。1フレーム後に再同期して、その場合でも正しい座標で描き直す
    const raf = requestAnimationFrame(() => {
      syncVLinesRef.current();
      syncRectsRef.current();
      syncTrendLinesRef.current();
      syncChannelsRef.current();
      syncArrowsRef.current();
      syncBrushesRef.current();
      syncTextsRef.current();
      syncWeekLinesRef.current();
      syncSessionsRef.current();
      syncTradeMarkersRef.current();

      syncCloudRef.current();
      syncScrubberRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [candles, cursor, isMain]);

  // 非メイン（4画面の他3枠）: 自前集計した足データ＋未来隠しクリップをそのままセットする。
  // メインと違いカーソル1ステップ＝1本という前提が無いため、
  // 「変化のたびに毎回まるごと再計算」方式（indicatorsの共有フル計算関数を使う）
  useEffect(() => {
    // nonMainVisible.length===0 でもここで早期returnしてはいけない。「未来隠しクリップの
    // 結果たまたま0本になった」場合も含まれるため、returnすると空のsetDataすら呼ばれず、
    // 直前に描画されていた古いデータセットの見た目がそのまま画面に残り続けてしまう
    // （新しいCSVを読み込んだ直後、cursor=0付近では上位時間足ほどまだ1本も閉じておらず
    // 0本になりやすい。この枠をクリックしてメインに昇格させると別経路の描画に切り替わり
    // 正しいデータに見えるため、あたかも「クリックしないと読み込まれない」不具合に見えていた）
    if (isMain) nonMainPrevRef.current = null; // メイン中のseriesは別内容になるので、降格後は必ず全体setDataから
    if (isMain || !seriesRef.current) return;

    // 再生中は「確定済みの足は同じで、末尾の形成中足の差し替え＋数本の追加だけ」が毎tick起きる。
    // その場合は全期間のsetData・指標の全再計算をせず、末尾だけ差分更新する（1Hパネルで数万本を
    // 毎tick作り直すと再生が間に合わなくなる）
    const prev = nonMainPrevRef.current;
    let tailFrom = -1;
    if (prev && prev.source === nonMainCandles && prev.tf === timeframeSec) {
      const pl = prev.data.length, nl = nonMainVisible.length, s = pl - 1;
      if (pl >= EMA_PERIOD + 1 && nl >= pl && nl - pl <= 400 &&
          nonMainVisible[0] === prev.data[0] && nonMainVisible[s - 1] === prev.data[s - 1] &&
          nonMainVisible[s].time === prev.data[s].time) tailFrom = s;
    }
    if (prev && tailFrom >= 0) {
      const tail = computeTail(nonMainVisible, tailFrom, timeframeSec, nonMainCandles, prev.emaClosed);
      for (let i = tailFrom; i < nonMainVisible.length; i++) seriesRef.current.update(toBar(nonMainVisible[i]));
      for (const pt of tail.ema) emaSeriesRef.current?.update(pt);
      for (const pt of tail.sma) smaSeriesRef.current?.update(pt);
      for (let i = 0; i < tail.bb.basis.length; i++) {
        bbBasisSeriesRef.current?.update(tail.bb.basis[i]);
        bbUpper1SeriesRef.current?.update(tail.bb.upper1[i]);
        bbLower1SeriesRef.current?.update(tail.bb.lower1[i]);
        bbUpper2SeriesRef.current?.update(tail.bb.upper2[i]);
        bbLower2SeriesRef.current?.update(tail.bb.lower2[i]);
      }
      for (const pt of tail.senkouA) senkouASeriesRef.current?.update(pt);
      for (const pt of tail.senkouB) senkouBSeriesRef.current?.update(pt);
      if (tail.points.length > 0) {
        const pts = cloudDataRef.current;
        while (pts.length > 0 && pts[pts.length - 1].time >= tail.points[0].time) pts.pop();
        cloudDataRef.current = [...pts, ...tail.points];
      }
      nonMainPrevRef.current = { source: nonMainCandles, tf: timeframeSec, data: nonMainVisible, emaClosed: tail.emaAtClosed };
    } else {
    seriesRef.current.setData(nonMainVisible.map(toBar));

    const emaData = computeEMA(nonMainVisible);
    emaSeriesRef.current?.setData(emaData);
    smaSeriesRef.current?.setData(computeSMA(nonMainVisible));

    const bb = computeBB(nonMainVisible);
    bbBasisSeriesRef.current?.setData(bb.basis);
    bbUpper1SeriesRef.current?.setData(bb.upper1);
    bbLower1SeriesRef.current?.setData(bb.lower1);
    bbUpper2SeriesRef.current?.setData(bb.upper2);
    bbLower2SeriesRef.current?.setData(bb.lower2);

    const cloud = computeCloud(nonMainVisible, timeframeSec, nonMainCandles);
    senkouASeriesRef.current?.setData(cloud.senkouA);
    senkouBSeriesRef.current?.setData(cloud.senkouB);
    cloudDataRef.current = cloud.points;
    nonMainPrevRef.current = emaData.length >= 2
      ? { source: nonMainCandles, tf: timeframeSec, data: nonMainVisible, emaClosed: emaData[emaData.length - 2].value }
      : null;
    }
    syncCloudRef.current();

    syncVLinesRef.current();
    syncRectsRef.current();
    syncTrendLinesRef.current();
    syncChannelsRef.current();
    syncArrowsRef.current();
    syncBrushesRef.current();
    syncTextsRef.current();
    syncWeekLinesRef.current();
    syncSessionsRef.current();
    syncTradeMarkersRef.current();
    // 新しいデータセットに切り替わった時だけ画面フィットする（CandleChart側の
    // 通常のフィット処理はcursor基準のためここでは自前で判定する）。
    // ただし「メインだった枠が今まさに降格した直後」は、この枠は既にメインとして
    // 相応の表示位置になっていたはずなので再フィットしない——スキップしないと、
    // 降格した瞬間にこの枠が勝手に「全期間表示」へ飛んでしまい、クリックした覚えのない
    // 別パネルが動いたように見える不具合になる（実際に指摘を受けて判明。あるパネルを
    // クリックしてメインに昇格させると、それまでメインだった別パネルが降格してこの
    // 分岐を初めて通ることになるため）
    // 空配列（自前集計の完了前）は「新しいデータセット」に数えない。数えると降格直後の
    // 再フィットスキップ（skipNextNonMainFitRef）が空データの同期で消費され、本物のデータ
    // が届いた時に再フィットが走って降格した枠が最新足へ飛んでしまう
    if (nonMainCandles.length > 0 && fittedNonMainDataRef.current !== nonMainCandles) {
      fittedNonMainDataRef.current = nonMainCandles;
      if (skipNextNonMainFitRef.current) {
        skipNextNonMainFitRef.current = false;
      } else {
        const saved = loadChartView(timeframeSec);
        const lastIdx = nonMainVisible.length - 1;
        if (saved && nonMainCandles.length > 0 && lastIdx >= 0) {
          // spanのクランプ基準はnonMainCandles（未来分も含む全期間の本数）を使うこと。
          // nonMainVisible（未来隠し後の実描画本数）でクランプすると、リプレイ序盤で
          // 実際に描画されている本数がごく少数な間、保存済みのspan（前回のズーム＝
          // 拡大率）がその少数本数まで潰されてしまい、少数のロウソク足が画面いっぱいに
          // 間延びして見える「デカ足」になる（「前回のスケールを覚えて再現してほしい」
          // という要望に反する——spanはズーム率の記憶なので、全期間本数を基準に
          // クランプしないと意味がない）。位置（barsFromRight）の方はrelativeViewToLogicalRange
          // の計算結果を使わず、常にnonMainVisibleの最後（＝実際に描画されている最新足）
          // を右オフセット分の位置に置く——保存ビューは縮尺だけ引き継ぎ、位置は
          // 「先頭から見る」仕様どおり常に今revealされている最新足に合わせる
          const { from, to } = relativeViewToLogicalRange(saved, nonMainCandles.length);
          const span = to - from;
          // メイン側と同じ理由で、revealされている本数（lastIdx+1）がspanより少ない
          // 序盤はfromが負にはみ出すためtoを固定してfromを0未満にクランプする
          const rangeTo = lastIdx + CHART_RIGHT_OFFSET_BARS;
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, rangeTo - span), to: rangeTo });
        } else if (nonMainVisible.length > 0) {
          // 時刻ベースのsetVisibleRange()は、setData直後などレイアウト未確定なタイミングで
          // 呼ぶと内部のtime→logical変換が失敗しクラッシュすることがある（実際に新規CSV
          // 読み込み直後に「Value is null」で画面クラッシュする形で発覚。centerOnTime等
          // 既存の地雷と同じ理由）。全期間を表示したいだけなので、時刻変換を経由しない
          // 足のインデックス（logical range）で直接指定する。
          // ここは実際にseries.setData()した本数＝nonMainVisible（未来隠し後）の本数を
          // 使うこと。nonMainCandles（未来分も含む全本数）を使うと、リプレイ序盤で
          // 実際に描画されている本数（nonMainVisible、ごく少数）がlogical range全体
          // （nonMainCandles、CSV全期間分）のごく一部に押し込められ、パネルがほぼ空欄に
          // 見える不具合になる（「特定の時間足にロウソク足が出てこない」不具合として発覚）
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: 0, to: nonMainVisible.length });
        }
      }
    }

    const raf = requestAnimationFrame(() => {
      syncCloudRef.current();
      syncVLinesRef.current();
      syncRectsRef.current();
      syncTrendLinesRef.current();
      syncChannelsRef.current();
      syncArrowsRef.current();
      syncBrushesRef.current();
      syncTextsRef.current();
      syncWeekLinesRef.current();
      syncSessionsRef.current();
      syncTradeMarkersRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [isMain, nonMainVisible, nonMainCandles, timeframeSec]);

  // 最新足への継続追従・4画面の十字カーソル同期・時間足切替時の表示位置・日付移動・ジャンプ同期
  // （chart/useViewRange.ts）。メイン/非メインのsetData effectより後ろで呼ぶこと（effectの実行順）
  useViewRangeSync({ ...viewRangeRefs, seriesRef, restoredViewKeyRef, mySourceIdRef, captureFollowAnchorRef }, {
    followLatest, cursor, nonMainVisible, isMain, crosshairSourceId, crosshairTime, displayCandles,
    timeframeSec, mySourceId, chartLayout, slot, candles, dataVersion,
    centerSignal, centerTarget, jumpSyncSignal, jumpSyncSourceId, jumpSyncTarget,
  });

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onMouseLeave={() => {
        const s = useTraderStore.getState();
        if (s.crosshairSourceId === mySourceId) s.setCrosshair(null, null);
      }}
    >
      <ChartHeader
        symbol={symbol}
        timeframeLabel={timeframeLabel}
        timeframeSec={timeframeSec}
        onSelectTimeframe={sec => {
          if (isMain) setTimeframe(sec); else setQuadTimeframe(slot, sec);
        }}
        disabled={!isLoaded}
        currentTime={mainDisplayTime ?? candles[cursor]?.time}
        atrPips={atrPips}
        chartRightMargin={chartRightMargin}
        isFullscreen={chartLayout === '1'}
        restoreLayoutLabel={`${preMultiLayout}画面`}
        tradeMarkersVisible={tradeMarkersVisible}
        onToggleTradeMarkers={() => toggleTradeMarkersForTimeframe(timeframeSec)}
        restrictOptions={restrictOptions}
        onRestrictKind={kind => restrictKindToTimeframe(kind, timeframeSec)}
        restoreOptions={restoreOptions}
        onRestoreKind={kind => showKindOnAllTimeframes(kind, timeframeSec)}
        onToggleFullscreen={() => {
          const s = useTraderStore.getState();
          if (s.chartLayout !== '1') {
            // マルチ画面時、非メイン枠の「全画面化」はまずその枠をメインへ昇格させてから
            // 1画面に切り替える（メイン以外の時間軸をそのまま1画面表示できるようにするため）
            if (!isMainRef.current) s.promoteSlotToMain(slotRef.current, nonMainCandlesRef.current);
            s.setChartLayout('1');
          } else {
            // 1画面解除時は直前のマルチ画面レイアウト（3画面/4画面）へ戻す
            s.setChartLayout(s.preMultiLayout);
          }
        }}
      />
      {/* 雲は価格軸の領域には侵入させない。他のオーバーレイと同じくright:chartRightMarginで
          幅を絞り、canvasの実描画もclientWidth基準（syncCloud内）なので自動的に追従する */}
      <canvas ref={cloudCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 5 }} />
      {/* 週区切り線は四角形（zIndex:9）より下（zIndex:8）にして「四角形が区切り線より上」を
          維持する（区切り線自体はローソク足の下である必要はなく、常時前面表示で問題ない） */}
      <div ref={weekOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 8 }} />
      {/* 東京/ロンドン/NYセッション帯。日付軸のすぐ上に1行だけ描く方式（syncSessions参照）なので
          週区切り線と同じ手前側のzIndexにして、ローソク足の下端に隠れないようにする */}
      <div ref={sessionOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 8 }} />
      {/* トレード履歴マーカー（エントリー/決済）。セッション帯と同じ下部の専用行にDOM要素で描き、
          ローソク足・インジケータと重ならないようにする（syncTradeMarkers参照）。個々のタグは
          クリック可能なのでコンテナ自体はpointerEvents:noneのまま子要素だけautoにしている */}
      <div ref={tradeMarkerOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 8 }} />
      {/* 四角形の枠線本体は専用canvasに自前描画（syncRects、destination-outでローソク足と
          重なった部分を透明に抜く）。価格軸に被らないよう幅はトレンドライン等と揃える。
          垂直線・四角形ハンドルのオーバーレイは価格軸の領域には侵入させない。overflow:hiddenと
          right:chartRightMarginで、価格軸に被る位置までスクロール/リサイズされた図形は
          その手前で切れて見えるようにする（スクラバーの右クランプと同じ考え方） */}
      <canvas ref={rectCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      <div ref={rectHandleOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      {/* トレンドラインは斜めの線分なのでDOMのborderで表現できず、専用canvasに描く
          （雲と同じ方式）。価格軸に被らないよう幅は四角形・テキストのオーバーレイと揃える */}
      <canvas ref={trendCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      {/* 平行チャネルもトレンドラインと同じ方式（専用canvas）。基準線＋価格オフセットした2本目の線を描く */}
      <canvas ref={channelCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      {/* 矢印はトレンドラインと同じ2点構造なので同じ方式（専用canvas）で描く。終点に矢印ヘッドを足すだけ。
          他の描画（四角形・トレンドライン・ブラシ・テキスト）より常に上に見せたいというわがままな
          要望のため、zIndexだけ他の描画系（9）より1段高くしてある。当たり判定側の優先順位も
          同じ理由でonMouseDown内の矢印チェックを他の描画より先に置いている */}
      <canvas ref={arrowCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 10, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      <canvas ref={brushCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      <div ref={textOverlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      {/* 垂直線の線本体も四角形の縦線と同じ方式（専用canvas、destination-outでローソク足と
          重なった部分を透明に抜く）。日付ラベル・選択ハンドルは従来通りoverlayRef側のDOMのまま */}
      <canvas ref={vlineCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      {/* 水平線の線本体も同じ方式（専用canvas、destination-outでローソク足と重なった部分を
          透明に抜く）。価格軸のラベルはcreatePriceLine（lineVisible:false）のまま残している */}
      <canvas ref={hlineCanvasRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, width: `calc(100% - ${chartRightMargin}px)`, height: '100%', pointerEvents: 'none', zIndex: 9, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      <div ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: `${chartRightMargin}px`, pointerEvents: 'none', overflow: 'hidden', zIndex: 11, visibility: overlaysHidden ? 'hidden' : 'visible' }} />
      <div ref={measureOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 12, display: 'none' }}>
        <div ref={measureBoxRef} style={{ position: 'absolute' }} />
        <div ref={measureMidLineRef} style={{ position: 'absolute', width: '0px' }} />
        <div ref={measureLabelRef} style={{
          position: 'absolute', backgroundColor: '#1a1a1a', border: '1px solid #333',
          borderRadius: '4px', padding: '6px 10px', whiteSpace: 'nowrap',
        }} />
      </div>
      <div ref={rrOverlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 13, display: 'none' }}>
        <div ref={rrTpBoxRef} style={{ position: 'absolute', backgroundColor: 'rgba(38,166,154,0.15)', display: 'none' }} />
        <div ref={rrSlBoxRef} style={{ position: 'absolute', backgroundColor: 'rgba(239,83,80,0.15)', display: 'none' }} />
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
