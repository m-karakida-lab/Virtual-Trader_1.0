import { create } from 'zustand';
import type { Candle, Position, ClosedTrade, PendingOrder, OrderType, Side, TimeframeSec, DrawnLine, DrawnVLine, DrawnRect, LineDash, LineWidth, LineSelection, MagnetMode } from '../types';
import { RECT_COLORS } from '../types';
import { TIMEFRAMES } from '../types';
import { initDuckDB, loadCSVFiles, queryCandles } from '../lib/duckdb';
import { detectQuoteCurrency, detectPairSymbol } from '../lib/currency';

const DEFAULT_INITIAL_BALANCE = 1_000_000;
const DEFAULT_TIMEFRAME: TimeframeSec = 900; // 15m

// クオート通貨ごとの初期残高デフォルト（JPYは100万、それ以外は1万。USD/EUR/GBP等で100万は非現実的なため）
function defaultBalanceFor(currency: string): number {
  return currency === 'JPY' ? 1_000_000 : 10_000;
}

// 再生速度は localStorage に記憶し、次回起動時も同じ速度から始める
const SPEED_STORAGE_KEY = 'vt:speed';

function loadSavedSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    const v = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(v) ? Math.min(20, Math.max(1, v)) : 1;
  } catch {
    return 1;
  }
}

function saveSpeed(speed: number): void {
  try {
    localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
  } catch {
    // localStorage が使えない場合は無視
  }
}

// マグネットの強さ（弱/強）は localStorage に記憶する。ON/OFF自体は他の描画ツールと
// 同じく起動のたびOFFに戻るが、「弱/強のどちらを使うか」は毎回選び直したくないため
const MAGNET_STRENGTH_STORAGE_KEY = 'vt:magnetStrength';

function loadSavedMagnetStrength(): Exclude<MagnetMode, 'off'> {
  try {
    return localStorage.getItem(MAGNET_STRENGTH_STORAGE_KEY) === 'strong' ? 'strong' : 'weak';
  } catch {
    return 'weak';
  }
}

function saveMagnetStrength(strength: Exclude<MagnetMode, 'off'>): void {
  try {
    localStorage.setItem(MAGNET_STRENGTH_STORAGE_KEY, strength);
  } catch {
    // localStorage が使えない場合は無視
  }
}

// 4画面レイアウトの「どの枠にどの時間軸を表示するか」（枠の位置=左上/左下/右上/右下は固定、
// 中身の時間軸だけユーザーが選べる）。デフォルトは 左上15m・左下1H・右上4H・右下1D
const QUAD_STORAGE_KEY = 'vt:quad';
const DEFAULT_QUAD_TIMEFRAMES: TimeframeSec[] = [900, 3600, 14400, 86400];
const QUAD_SLOT_COUNT = DEFAULT_QUAD_TIMEFRAMES.length;

function isTimeframeSec(v: unknown): v is TimeframeSec {
  return typeof v === 'number' && TIMEFRAMES.some(tf => tf.sec === v);
}

function loadSavedQuad(): { quadTimeframes: TimeframeSec[]; quadMainSlot: number } {
  try {
    const raw = localStorage.getItem(QUAD_STORAGE_KEY);
    if (!raw) throw new Error('no saved quad');
    const parsed = JSON.parse(raw);
    const tfs = parsed.quadTimeframes;
    if (!Array.isArray(tfs) || tfs.length !== QUAD_SLOT_COUNT || !tfs.every(isTimeframeSec)) {
      throw new Error('invalid quadTimeframes');
    }
    const slot = Number(parsed.quadMainSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= QUAD_SLOT_COUNT) throw new Error('invalid quadMainSlot');
    // メイン時間軸（timeframeSec）自体は再生速度と違い永続化せず常にDEFAULT_TIMEFRAMEで起動するため、
    // メイン枠（quadMainSlot）が保持する時間軸もそれに揃えておく（揃えないと起動直後だけ
    // 「メイン枠の見出し」と「実際に表示される時間軸」が食い違う）
    tfs[slot] = DEFAULT_TIMEFRAME;
    return { quadTimeframes: tfs, quadMainSlot: slot };
  } catch {
    return { quadTimeframes: DEFAULT_QUAD_TIMEFRAMES, quadMainSlot: 0 };
  }
}

function saveQuad(quadTimeframes: TimeframeSec[], quadMainSlot: number): void {
  try {
    localStorage.setItem(QUAD_STORAGE_KEY, JSON.stringify({ quadTimeframes, quadMainSlot }));
  } catch {
    // localStorage が使えない場合は無視
  }
}

interface TraderState {
  isLoaded: boolean;
  isLoading: boolean;
  loadingMsg: string;
  candles: Candle[];
  timeframeSec: TimeframeSec;
  cursor: number;
  initialBalance: number; // CSV読み込み・リセット時の開始残高
  isInitialBalanceCustom: boolean; // ユーザーが手動で初期残高を変更したか（trueなら通貨切替時の自動調整をしない）
  balance: number;
  positions: Position[];
  pendingOrders: PendingOrder[]; // 指値・逆指値の未約定注文
  nextOrderId: number;
  closedTrades: ClosedTrade[]; // 決済済みトレード履歴（チャート上のマーカー表示用）
  quoteCurrency: string; // 残高・損益の単位（読み込んだペアのクオート通貨。例: EURUSD→USD）
  symbol: string; // 読み込んだ通貨ペアのシンボル（例: "USDJPY"）。チャートヘッダー表示用
  lots: number;          // 発注ロット数（固定モード時に使用）
  lotMode: 'fixed' | 'risk'; // ロット指定方法
  riskPercent: number;       // リスクモード時: 残高に対する許容損失の割合（%）
  nextId: number;        // ポジション ID カウンタ
  orderType: OrderType;  // 発注パネルで選択中の注文種別
  draftPrice: number | null; // 指値・逆指値の発注価格（draft）
  draftTP: number | null;    // 発注時の TP（draft）
  draftSL: number | null;    // 発注時の SL（draft）
  pickTarget: 'price' | 'tp' | 'sl' | null; // チャートクリックで price/tp/sl に値を入れるモード
  error: string | null;
  isPlaying: boolean;
  speed: number;         // 1〜20
  lines: DrawnLine[];
  nextLineId: number;
  isDrawingLine: boolean;
  vlines: DrawnVLine[];
  nextVLineId: number;
  isDrawingVLine: boolean;
  isMeasuring: boolean;
  rects: DrawnRect[];
  nextRectId: number;
  isDrawingRect: boolean;
  magnetMode: MagnetMode; // 描画時に価格を足の高値/安値/始値/終値へ吸着させる強さ
  magnetStrength: Exclude<MagnetMode, 'off'>; // OFF→ON時に使う強さ（localStorageに記憶）
  selected: LineSelection | null; // 水平線・垂直線・四角形のいずれか選択中の1つ
  lineDraft: { color: string; dash: LineDash; width: LineWidth };
  rectDraft: { color: string; dash: LineDash; width: LineWidth };
  // パレットモード: ONの間、水平線・垂直線・四角形をクリックして選択（編集モード）に
  // 入れるたびpaletteStyleの色・線種・太さをその図形へ即座に反映する（一括塗り替え用）
  paletteMode: boolean;
  paletteStyle: { color: string; dash: LineDash; width: LineWidth };
  showEMA: boolean;
  showSMA: boolean;
  showBB: boolean;
  showCloud: boolean;
  showWeekLines: boolean;
  showFullHistory: boolean;
  showHistoryPanel: boolean; // 取引履歴・損益グラフのパネル表示
  chartRightMargin: number;  // チャート右側の価格軸の実測幅(px)。フロートパネルの配置クランプ用
  chartBottomMargin: number; // チャート下部の時間軸の実測高さ(px)。フロートパネルの配置クランプ用
  fitSignal: number;  // fitToScreen が呼ばれるたびに増える（チャート側の fitContent 起動トリガ用）
  scrollToLatestSignal: number; // scrollToLatest が呼ばれるたびに増える（最新足を右寄せで表示するトリガ用）
  centerSignal: number; // centerOnTime が呼ばれるたびに増える
  centerTarget: number;  // centerOnTime の移動先（Unix秒）
  chartLayout: '1' | '4'; // 1画面 / 4画面（時間軸別マルチチャート）
  quadTimeframes: TimeframeSec[]; // 4画面の各枠（左上/左下/右上/右下）に表示する時間軸
  quadMainSlot: number; // quadTimeframes のうち、現在メイン（操作可能）になっている枠のインデックス
  dataVersion: number; // CSV読み込みが完了するたびに増える（ミニチャートの再集計トリガ用）
  crosshairSourceId: string | null; // 4画面時、実際にマウスホバー中のパネルID（'main' またはミニ枠のslot番号文字列）
  crosshairTime: number | null; // ↑のパネルで十字カーソルが指している時刻（Unix秒）。他パネルはこの時刻に同期表示する

  setInitialBalance: (v: number) => void;
  resetAccount: () => void;
  loadFiles: (files: FileList | File[]) => Promise<void>;
  setTimeframe: (sec: TimeframeSec) => Promise<void>;
  advance: () => boolean;
  stepBack: () => boolean;
  jumpToTime: (targetSec: number) => void;
  fitToScreen: () => void;
  scrollToLatest: () => void;
  centerOnTime: (time: number) => void;
  setOrderType: (t: OrderType) => void;
  setDraftPrice: (v: number | null) => void;
  setDraftTP: (v: number | null) => void;
  setDraftSL: (v: number | null) => void;
  togglePickTarget: (t: 'price' | 'tp' | 'sl') => void;
  pickPrice: (price: number) => void;
  submitOrder: (side: Side) => void;
  cancelOrder: (id: number) => void;
  updateOrderPrice: (id: number, price: number) => void;
  setOrderTP: (id: number, tp: number | undefined) => void;
  setOrderSL: (id: number, sl: number | undefined) => void;
  setPositionTP: (id: number, tp: number | undefined) => void;
  setPositionSL: (id: number, sl: number | undefined) => void;
  closePosition: (id: number) => void;
  closeAll: () => void;
  setLots: (lots: number) => void;
  setLotMode: (m: 'fixed' | 'risk') => void;
  setRiskPercent: (v: number) => void;
  togglePlay: () => void;
  setSpeed: (speed: number) => void;
  addLine: (price: number) => void;
  updateLine: (id: number, patch: Partial<Omit<DrawnLine, 'id'>>) => void;
  removeLine: (id: number) => void;
  duplicateLine: (id: number, newPrice: number) => void;
  toggleDrawLine: () => void;
  addVLine: (time: number) => void;
  updateVLine: (id: number, patch: Partial<Omit<DrawnVLine, 'id'>>) => void;
  removeVLine: (id: number) => void;
  duplicateVLine: (id: number, newTime: number) => void;
  toggleDrawVLine: () => void;
  toggleMeasure: () => void;
  addRect: (time1: number, price1: number, time2: number, price2: number) => void;
  updateRect: (id: number, patch: Partial<Omit<DrawnRect, 'id'>>) => void;
  removeRect: (id: number) => void;
  duplicateRect: (id: number, time1: number, price1: number, time2: number, price2: number) => void;
  toggleDrawRect: () => void;
  setMagnetMode: (mode: MagnetMode) => void;
  toggleMagnet: () => void;
  selectLine: (target: LineSelection | null) => void;
  togglePaletteMode: () => void;
  setPaletteStyle: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  toggleEMA: () => void;
  toggleSMA: () => void;
  toggleBB: () => void;
  toggleCloud: () => void;
  toggleWeekLines: () => void;
  advanceToEnd: () => void;
  toggleHistoryPanel: () => void;
  setChartMargins: (right: number, bottom: number) => void;
  setChartLayout: (layout: '1' | '4') => void;
  setQuadTimeframe: (slot: number, sec: TimeframeSec) => void;
  promoteSlotToMain: (slot: number) => void;
  setCrosshair: (sourceId: string | null, time: number | null) => void;
  clearError: () => void;
}

// 通過したローソク足の範囲（fromIdx は除外、toIdx は含む）について
// 未約定注文の約定判定・オープン中ポジションの TP/SL 判定を行う。
// 高値・安値がレベルを跨いだら約定（始値ベースではなく範囲ベースで判定）。
function processOrderRange(
  candles: Candle[],
  fromIdx: number,
  toIdx: number,
  positions: Position[],
  pendingOrders: PendingOrder[],
  closedTrades: ClosedTrade[],
  balance: number,
  nextId: number,
): { positions: Position[]; pendingOrders: PendingOrder[]; closedTrades: ClosedTrade[]; balance: number; nextId: number; changed: boolean } {
  let changed = false;

  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const c = candles[i];
    if (!c) break;

    if (pendingOrders.length > 0) {
      const stillPending: PendingOrder[] = [];
      for (const order of pendingOrders) {
        if (c.low <= order.price && order.price <= c.high) {
          positions = [...positions, {
            id: nextId, side: order.side, openPrice: order.price,
            lots: order.lots, openTime: c.time, tp: order.tp, sl: order.sl,
          }];
          nextId += 1;
          changed = true;
        } else {
          stillPending.push(order);
        }
      }
      pendingOrders = stillPending;
    }

    if (positions.length > 0) {
      const stillOpen: Position[] = [];
      for (const pos of positions) {
        // SL を先に判定する（同一バーで TP/SL 両方ヒットした場合は不利な方を優先）
        let exitPrice: number | undefined;
        if (pos.side === 'BUY') {
          if (pos.sl !== undefined && c.low <= pos.sl) exitPrice = pos.sl;
          else if (pos.tp !== undefined && c.high >= pos.tp) exitPrice = pos.tp;
        } else {
          if (pos.sl !== undefined && c.high >= pos.sl) exitPrice = pos.sl;
          else if (pos.tp !== undefined && c.low <= pos.tp) exitPrice = pos.tp;
        }
        if (exitPrice !== undefined) {
          const dir = pos.side === 'BUY' ? 1 : -1;
          const pnl = (exitPrice - pos.openPrice) * pos.lots * dir;
          balance += pnl;
          closedTrades = [...closedTrades, {
            id: pos.id, side: pos.side, openPrice: pos.openPrice, closePrice: exitPrice,
            openTime: pos.openTime, closeTime: c.time, lots: pos.lots, pnl,
          }];
          changed = true;
        } else {
          stillOpen.push(pos);
        }
      }
      positions = stillOpen;
    }
  }

  return { positions, pendingOrders, closedTrades, balance, nextId, changed };
}

// パレットモード中に、選択中の図形へ現在のpaletteStyleを書き込む（色・線種・太さ）。
// パレット側の設定を変えた時（setPaletteStyle）から呼ばれる。
// 「選択しただけ」では図形側は変えない（syncPaletteStyleFromと役割が逆）
function applyPaletteStyleTo(get: () => TraderState, target: LineSelection): void {
  const { paletteStyle } = get();
  if (target.kind === 'h') get().updateLine(target.id, paletteStyle);
  else if (target.kind === 'v') get().updateVLine(target.id, paletteStyle);
  else get().updateRect(target.id, paletteStyle);
}

// パレットモードで図形を選択（編集モードに入る）した時に、その図形の現在のスタイルを
// パレット側へ取り込む（選択しただけで図形の見た目が変わらないように）
function syncPaletteStyleFrom(set: (fn: (s: TraderState) => Partial<TraderState>) => void, get: () => TraderState, target: LineSelection): void {
  const s = get();
  if (target.kind === 'h') {
    const line = s.lines.find(l => l.id === target.id);
    if (line) set(() => ({ paletteStyle: { color: line.color, dash: line.dash, width: line.width } }));
  } else if (target.kind === 'v') {
    const v = s.vlines.find(vv => vv.id === target.id);
    if (v) set(() => ({ paletteStyle: { color: v.color, dash: v.dash, width: v.width } }));
  } else {
    const r = s.rects.find(rr => rr.id === target.id);
    if (r) set(() => ({ paletteStyle: { color: r.color, dash: r.dash, width: r.width } }));
  }
}

export const useTraderStore = create<TraderState>((set, get) => ({
  isLoaded: false,
  isLoading: false,
  loadingMsg: '',
  candles: [],
  timeframeSec: DEFAULT_TIMEFRAME,
  cursor: 0,
  initialBalance: DEFAULT_INITIAL_BALANCE,
  isInitialBalanceCustom: false,
  balance: DEFAULT_INITIAL_BALANCE,
  positions: [],
  pendingOrders: [],
  nextOrderId: 1,
  closedTrades: [],
  quoteCurrency: 'JPY',
  symbol: '',
  lots: 10_000,
  lotMode: 'risk',
  riskPercent: 3,
  nextId: 1,
  orderType: 'market',
  draftPrice: null,
  draftTP: null,
  draftSL: null,
  pickTarget: null,
  error: null,
  isPlaying: false,
  speed: loadSavedSpeed(),
  lines: [],
  nextLineId: 1,
  isDrawingLine: false,
  vlines: [],
  nextVLineId: 1,
  isDrawingVLine: false,
  isMeasuring: false,
  rects: [],
  nextRectId: 1,
  isDrawingRect: false,
  magnetMode: 'off',
  magnetStrength: loadSavedMagnetStrength(),
  selected: null,
  lineDraft: { color: '#42a5f5', dash: 'solid', width: 2 },
  rectDraft: { color: RECT_COLORS[0], dash: 'solid', width: 2 },
  paletteMode: false,
  paletteStyle: { color: '#42a5f5', dash: 'solid', width: 2 },
  showEMA: false,
  showSMA: true,
  showBB: true,
  showCloud: true,
  showWeekLines: true,
  showFullHistory: false,
  showHistoryPanel: false,
  chartRightMargin: 60,
  chartBottomMargin: 28,
  fitSignal: 0,
  scrollToLatestSignal: 0,
  centerSignal: 0,
  centerTarget: 0,
  chartLayout: '4',
  ...loadSavedQuad(),
  dataVersion: 0,
  crosshairSourceId: null,
  crosshairTime: null,

  loadFiles: async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    set({ isLoading: true, error: null, loadingMsg: '初期化中...' });
    try {
      const db = await initDuckDB();
      await loadCSVFiles(db, fileArray, (current, total, name) => {
        set({ loadingMsg: `${current}/${total}: ${name}` });
      });
      set({ loadingMsg: '集計中...' });
      const { timeframeSec, initialBalance, isInitialBalanceCustom } = get();
      const candles = await queryCandles(db, timeframeSec);
      const quoteCurrency = detectQuoteCurrency(fileArray[0].name);
      const symbol = detectPairSymbol(fileArray[0].name);
      // ユーザーが初期残高を手動で変更していなければ、クオート通貨に応じたデフォルトに合わせる
      const newInitialBalance = isInitialBalanceCustom ? initialBalance : defaultBalanceFor(quoteCurrency);
      set({
        candles, cursor: 0, isLoaded: true,
        isLoading: false, loadingMsg: `✓ ${candles.length.toLocaleString()}本 読み込み完了`,
        balance: newInitialBalance, initialBalance: newInitialBalance,
        positions: [], pendingOrders: [], nextOrderId: 1,
        closedTrades: [], nextId: 1,
        isPlaying: false,
        lines: [], nextLineId: 1, vlines: [], nextVLineId: 1, rects: [], nextRectId: 1, selected: null,
        showFullHistory: false, quoteCurrency, symbol,
        dataVersion: get().dataVersion + 1,
      });
      setTimeout(() => {
        if (get().loadingMsg.startsWith('✓')) set({ loadingMsg: '' });
      }, 5000);
    } catch (e) {
      set({ error: String(e), isLoading: false, loadingMsg: '' });
    }
  },

  setTimeframe: async (sec: TimeframeSec) => {
    const { isLoaded, isLoading, timeframeSec, candles, cursor, quadTimeframes, quadMainSlot } = get();
    if (!isLoaded || isLoading || sec === timeframeSec) return;

    // 現在の足の終了時刻（＝閉じている範囲の境界）を保持し、新しい時間軸でも
    // その時点までに閉じている足だけを選ぶ（MiniChartの先出し防止条件と揃える。
    // 開始時刻だけで比較すると、切替先の未確定の足が誤って選ばれ1本先出しになる）
    const currentClose = candles[cursor] !== undefined ? candles[cursor].time + timeframeSec : undefined;

    set({ isLoading: true, loadingMsg: '集計中...', isPlaying: false });
    try {
      const db = await initDuckDB();
      const newCandles = await queryCandles(db, sec);

      let newCursor = 0;
      if (currentClose !== undefined) {
        for (let i = 0; i < newCandles.length; i++) {
          if (newCandles[i].time + sec <= currentClose) newCursor = i;
          else break;
        }
      }

      // メインが表示されている枠（quadMainSlot）の時間軸も、メイン切替に追従させる
      const newQuadTimeframes = quadTimeframes.slice();
      newQuadTimeframes[quadMainSlot] = sec;
      saveQuad(newQuadTimeframes, quadMainSlot);

      set({
        candles: newCandles, timeframeSec: sec, cursor: newCursor,
        quadTimeframes: newQuadTimeframes,
        isLoading: false, loadingMsg: '',
      });
    } catch (e) {
      set({ error: String(e), isLoading: false, loadingMsg: '' });
    }
  },

  advance: () => {
    const { cursor, candles, positions, pendingOrders, closedTrades, balance, nextId } = get();
    if (cursor < candles.length - 1) {
      const newCursor = cursor + 1;
      const result = processOrderRange(candles, cursor, newCursor, positions, pendingOrders, closedTrades, balance, nextId);
      set({
        cursor: newCursor,
        ...(result.changed ? {
          positions: result.positions, pendingOrders: result.pendingOrders,
          closedTrades: result.closedTrades, balance: result.balance, nextId: result.nextId,
        } : {}),
      });
      return true;
    }
    set({ isPlaying: false });
    return false;
  },

  // カーソルを1つ戻す（表示のみ。約定済みの注文・決済は取り消さない）
  stepBack: () => {
    const { cursor } = get();
    if (cursor <= 0) {
      set({ isPlaying: false });
      return false;
    }
    set({ cursor: cursor - 1, isPlaying: false });
    return true;
  },

  jumpToTime: (targetSec: number) => {
    const { candles, cursor: oldCursor, positions, pendingOrders, closedTrades, balance, nextId } = get();
    if (candles.length === 0) return;
    // 二分探索: targetSec 以下の最後の足を探す
    let lo = 0, hi = candles.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= targetSec) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    // 前進ジャンプの場合だけ、通過した範囲の注文約定・TP/SL判定を行う
    const result = idx > oldCursor
      ? processOrderRange(candles, oldCursor, idx, positions, pendingOrders, closedTrades, balance, nextId)
      : null;

    // 過去日付へのジャンプは cursor を戻さない（表示位置を動かすだけ）。
    // cursor はリプレイの進行位置＝データの開示境界そのものなので、ここを巻き戻すと
    // 「6/1へジャンプしたら7/1まで見えていた足が6/1以降ごと隠れて、6/1が最新足になる」
    // という直感に反する挙動になる。未来日付へのジャンプは従来どおり cursor を進め、
    // 通過した範囲の注文約定・TP/SL判定も行う（バックテストとして時間を進める意味がある）
    // 垂直線チップ移動と同じ「縮尺維持で中心移動」を使う
    set(s => ({
      cursor: Math.max(idx, oldCursor), isPlaying: false, centerTarget: targetSec, centerSignal: s.centerSignal + 1,
      ...(result?.changed ? {
        positions: result.positions, pendingOrders: result.pendingOrders,
        closedTrades: result.closedTrades, balance: result.balance, nextId: result.nextId,
      } : {}),
    }));
  },

  fitToScreen: () => set(s => ({ fitSignal: s.fitSignal + 1 })),
  scrollToLatest: () => set(s => ({ scrollToLatestSignal: s.scrollToLatestSignal + 1 })),
  centerOnTime: (time: number) => set(s => ({ centerTarget: time, centerSignal: s.centerSignal + 1 })),

  setInitialBalance: (v: number) => set({ initialBalance: Math.max(0, v), isInitialBalanceCustom: true }),
  resetAccount: () => {
    const { initialBalance } = get();
    set({
      balance: initialBalance, positions: [], pendingOrders: [], nextOrderId: 1,
      closedTrades: [], nextId: 1, isPlaying: false,
    });
  },

  setOrderType: (t: OrderType) => set({ orderType: t }),
  setDraftPrice: (v: number | null) => set({ draftPrice: v }),
  setDraftTP: (v: number | null) => set({ draftTP: v }),
  setDraftSL: (v: number | null) => set({ draftSL: v }),

  togglePickTarget: (t: 'price' | 'tp' | 'sl') => {
    set(s => ({
      pickTarget: s.pickTarget === t ? null : t,
      isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false,
    }));
  },
  pickPrice: (price: number) => {
    const { pickTarget } = get();
    if (pickTarget === 'price') set({ draftPrice: price, pickTarget: null });
    else if (pickTarget === 'tp') set({ draftTP: price, pickTarget: null });
    else if (pickTarget === 'sl') set({ draftSL: price, pickTarget: null });
  },

  submitOrder: (side: Side) => {
    const { orderType, lots, lotMode, riskPercent, draftPrice, draftTP, draftSL, candles, cursor, positions, nextId, pendingOrders, nextOrderId, balance } = get();
    const c = candles[cursor];
    if (!c) return;
    const tp = draftTP ?? undefined;
    const sl = draftSL ?? undefined;
    const entryPrice = orderType === 'market' ? c.close : draftPrice;

    // リスク%モード: 残高 × risk% ÷ |エントリー価格 - SL| からロット数を逆算する
    let useLots = lots;
    if (lotMode === 'risk') {
      if (sl === undefined || entryPrice === null) {
        set({ error: 'リスク%指定には SL の設定が必要です' });
        return;
      }
      const stopDistance = Math.abs(entryPrice - sl);
      if (stopDistance === 0) {
        set({ error: 'SL がエントリー価格と同じです' });
        return;
      }
      useLots = Math.round((balance * (riskPercent / 100)) / stopDistance);
      if (useLots <= 0) {
        set({ error: '計算されたロット数が0以下です' });
        return;
      }
    }

    if (orderType === 'market') {
      // 証拠金チェック（簡易: 1証拠金 = lots × price × 0.04 ≒ 4%）
      const margin = useLots * c.close * 0.04;
      if (balance < margin) {
        set({ error: '残高が不足しています' });
        return;
      }
      set({
        positions: [...positions, { id: nextId, side, openPrice: c.close, lots: useLots, openTime: c.time, tp, sl }],
        nextId: nextId + 1,
        draftTP: null, draftSL: null,
      });
    } else {
      if (draftPrice === null) return;

      // 指値・逆指値は現在値との上下関係が決まっている（実際の注文として成立する条件）
      // STOP-BUY: 現在値より上 / STOP-SELL: 現在値より下 / LIMIT-BUY: 現在値より下 / LIMIT-SELL: 現在値より上
      const mustBeAbove = orderType === 'stop' ? side === 'BUY' : side === 'SELL';
      const isAbove = draftPrice > c.close;
      if (isAbove !== mustBeAbove) {
        const typeLabel = orderType === 'stop' ? '逆指値' : '指値';
        set({ error: `${side} ${typeLabel} は現在値(${c.close})より${mustBeAbove ? '上' : '下'}の価格を指定してください` });
        return;
      }

      set({
        pendingOrders: [...pendingOrders, { id: nextOrderId, side, type: orderType, price: draftPrice, lots: useLots, tp, sl }],
        nextOrderId: nextOrderId + 1,
        draftPrice: null, draftTP: null, draftSL: null, error: null,
      });
    }
  },

  cancelOrder: (id: number) => {
    set(s => ({ pendingOrders: s.pendingOrders.filter(o => o.id !== id) }));
  },
  updateOrderPrice: (id: number, price: number) => {
    set(s => ({ pendingOrders: s.pendingOrders.map(o => o.id === id ? { ...o, price } : o) }));
  },
  setOrderTP: (id: number, tp: number | undefined) => {
    set(s => ({ pendingOrders: s.pendingOrders.map(o => o.id === id ? { ...o, tp } : o) }));
  },
  setOrderSL: (id: number, sl: number | undefined) => {
    set(s => ({ pendingOrders: s.pendingOrders.map(o => o.id === id ? { ...o, sl } : o) }));
  },
  setPositionTP: (id: number, tp: number | undefined) => {
    set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, tp } : p) }));
  },
  setPositionSL: (id: number, sl: number | undefined) => {
    set(s => ({ positions: s.positions.map(p => p.id === id ? { ...p, sl } : p) }));
  },

  closePosition: (id: number) => {
    const { positions, candles, cursor, balance, closedTrades } = get();
    const pos = positions.find(p => p.id === id);
    if (!pos) return;
    const c = candles[cursor];
    if (!c) return;
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnl = (c.close - pos.openPrice) * pos.lots * dir;
    set({
      balance: balance + pnl,
      positions: positions.filter(p => p.id !== id),
      closedTrades: [...closedTrades, {
        id: pos.id, side: pos.side, openPrice: pos.openPrice, closePrice: c.close,
        openTime: pos.openTime, closeTime: c.time, lots: pos.lots, pnl,
      }],
    });
  },

  closeAll: () => {
    const { positions, candles, cursor, balance, closedTrades } = get();
    const c = candles[cursor];
    if (!c || positions.length === 0) return;
    const newTrades: ClosedTrade[] = positions.map(pos => {
      const dir = pos.side === 'BUY' ? 1 : -1;
      const pnl = (c.close - pos.openPrice) * pos.lots * dir;
      return {
        id: pos.id, side: pos.side, openPrice: pos.openPrice, closePrice: c.close,
        openTime: pos.openTime, closeTime: c.time, lots: pos.lots, pnl,
      };
    });
    const totalPnl = newTrades.reduce((sum, t) => sum + t.pnl, 0);
    set({ balance: balance + totalPnl, positions: [], closedTrades: [...closedTrades, ...newTrades] });
  },

  setLots: (lots: number) => set({ lots }),
  setLotMode: (m: 'fixed' | 'risk') => set({ lotMode: m }),
  setRiskPercent: (v: number) => set({ riskPercent: Math.max(0, v) }),
  togglePlay: () => set(s => ({ isPlaying: !s.isPlaying })),
  setSpeed: (speed: number) => {
    const clamped = Math.min(20, Math.max(1, speed));
    saveSpeed(clamped);
    set({ speed: clamped });
  },

  addLine: (price: number) => {
    // 丸めない（表示側で toFixed するだけにし、線の位置は連続値で持つ）
    const { lines, nextLineId, lineDraft } = get();
    set({
      lines: [...lines, { id: nextLineId, price, ...lineDraft }],
      nextLineId: nextLineId + 1,
      isDrawingLine: false,
    });
    // 配置直後はそのまま編集モードに入れる（selectLine経由でパレットモードの自動ONも揃う）
    get().selectLine({ kind: 'h', id: nextLineId });
  },
  updateLine: (id: number, patch: Partial<Omit<DrawnLine, 'id'>>) => {
    set(s => ({ lines: s.lines.map(l => l.id === id ? { ...l, ...patch } : l) }));
  },
  removeLine: (id: number) => {
    set(s => {
      const wasSelected = s.selected?.kind === 'h' && s.selected.id === id;
      return {
        lines: s.lines.filter(l => l.id !== id),
        selected: wasSelected ? null : s.selected,
        // 選択中の図形を削除した場合も編集モード終了とみなし、パレットも自動でOFFにする
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  // 選択中の線を色・線種・太さそのままに複製する（新規描画のaddLineと違い、
  // 現在のlineDraftではなく複製元自身のスタイルを引き継ぐ）
  duplicateLine: (id: number, newPrice: number) => {
    const { lines, nextLineId } = get();
    const src = lines.find(l => l.id === id);
    if (!src) return;
    set({ lines: [...lines, { ...src, id: nextLineId, price: newPrice }], nextLineId: nextLineId + 1 });
  },
  toggleDrawLine: () => set(s => ({ isDrawingLine: !s.isDrawingLine, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, pickTarget: null })),

  addVLine: (time: number) => {
    const { vlines, nextVLineId, lineDraft } = get();
    set({
      vlines: [...vlines, { id: nextVLineId, time, ...lineDraft }],
      nextVLineId: nextVLineId + 1,
      isDrawingVLine: false,
    });
    get().selectLine({ kind: 'v', id: nextVLineId });
  },
  updateVLine: (id: number, patch: Partial<Omit<DrawnVLine, 'id'>>) => {
    set(s => ({ vlines: s.vlines.map(v => v.id === id ? { ...v, ...patch } : v) }));
  },
  removeVLine: (id: number) => {
    set(s => {
      const wasSelected = s.selected?.kind === 'v' && s.selected.id === id;
      return {
        vlines: s.vlines.filter(v => v.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateVLine: (id: number, newTime: number) => {
    const { vlines, nextVLineId } = get();
    const src = vlines.find(v => v.id === id);
    if (!src) return;
    set({ vlines: [...vlines, { ...src, id: nextVLineId, time: newTime }], nextVLineId: nextVLineId + 1 });
  },
  toggleDrawVLine: () => set(s => ({ isDrawingVLine: !s.isDrawingVLine, isDrawingLine: false, isMeasuring: false, isDrawingRect: false, pickTarget: null })),
  toggleMeasure: () => set(s => ({ isMeasuring: !s.isMeasuring, isDrawingLine: false, isDrawingVLine: false, isDrawingRect: false, pickTarget: null })),

  addRect: (time1: number, price1: number, time2: number, price2: number) => {
    const { rects, nextRectId, rectDraft } = get();
    set({
      rects: [...rects, { id: nextRectId, time1, price1, time2, price2, ...rectDraft }],
      nextRectId: nextRectId + 1,
      isDrawingRect: false,
    });
    get().selectLine({ kind: 'rect', id: nextRectId });
  },
  updateRect: (id: number, patch: Partial<Omit<DrawnRect, 'id'>>) => {
    set(s => ({ rects: s.rects.map(r => r.id === id ? { ...r, ...patch } : r) }));
  },
  removeRect: (id: number) => {
    set(s => {
      const wasSelected = s.selected?.kind === 'rect' && s.selected.id === id;
      return {
        rects: s.rects.filter(r => r.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateRect: (id: number, time1: number, price1: number, time2: number, price2: number) => {
    const { rects, nextRectId } = get();
    const src = rects.find(r => r.id === id);
    if (!src) return;
    set({ rects: [...rects, { ...src, id: nextRectId, time1, price1, time2, price2 }], nextRectId: nextRectId + 1 });
  },
  toggleDrawRect: () => set(s => ({ isDrawingRect: !s.isDrawingRect, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, pickTarget: null })),
  setMagnetMode: mode => {
    if (mode !== 'off') saveMagnetStrength(mode);
    set(s => ({ magnetMode: mode, magnetStrength: mode !== 'off' ? mode : s.magnetStrength }));
  },
  // アイコン本体クリックでのON/OFFトグル。OFF→ONは直前に選んだ強さ（magnetStrength）から始める
  toggleMagnet: () => set(s => ({ magnetMode: s.magnetMode === 'off' ? s.magnetStrength : 'off' })),

  selectLine: (target: LineSelection | null) => {
    set({ selected: target });
    if (!target) {
      // 編集モードを抜けたら（選択解除）パレットも自動でOFFにする（自動ONと対になる挙動）
      if (get().paletteMode) set({ paletteMode: false });
      return;
    }
    // 水平線・垂直線・四角形を編集モードに入れたら、パレットが閉じていても自動でONにする
    // （選んだ図形のスタイルをパレット側へ取り込むところまで一気に済ませるため）
    if (!get().paletteMode) set({ paletteMode: true });
    syncPaletteStyleFrom(set, get, target);
  },
  togglePaletteMode: () => set(s => ({ paletteMode: !s.paletteMode })),
  setPaletteStyle: patch => {
    set(s => ({ paletteStyle: { ...s.paletteStyle, ...patch } }));
    // 編集モード（選択中）のままパレットの設定を変えた時も、選び直さなくてもすぐ反映する
    const { paletteMode, selected } = get();
    if (paletteMode && selected) applyPaletteStyleTo(get, selected);
  },
  toggleEMA: () => set(s => ({ showEMA: !s.showEMA })),
  toggleSMA: () => set(s => ({ showSMA: !s.showSMA })),
  toggleBB: () => set(s => ({ showBB: !s.showBB })),
  toggleCloud: () => set(s => ({ showCloud: !s.showCloud })),
  toggleWeekLines: () => set(s => ({ showWeekLines: !s.showWeekLines })),
  // 「全体を見る」: 一時的なプレビューではなく、読み込んだデータの最後まで実際に
  // カーソルを進める（通過した範囲の注文約定・TP/SL判定も行う。advanceを1本ずつ
  // 呼ぶ代わりにprocessOrderRangeへ一括で渡すことで、本数が多くても一瞬で終わる）
  advanceToEnd: () => {
    const { cursor, candles, positions, pendingOrders, closedTrades, balance, nextId } = get();
    if (candles.length === 0) return;
    const lastIdx = candles.length - 1;
    if (cursor >= lastIdx) { set({ showFullHistory: true, isPlaying: false }); return; }
    const result = processOrderRange(candles, cursor, lastIdx, positions, pendingOrders, closedTrades, balance, nextId);
    set({
      cursor: lastIdx,
      showFullHistory: true,
      isPlaying: false,
      ...(result.changed ? {
        positions: result.positions, pendingOrders: result.pendingOrders,
        closedTrades: result.closedTrades, balance: result.balance, nextId: result.nextId,
      } : {}),
    });
  },
  toggleHistoryPanel: () => set(s => ({ showHistoryPanel: !s.showHistoryPanel })),
  setChartMargins: (right: number, bottom: number) => set({ chartRightMargin: right, chartBottomMargin: bottom }),
  setChartLayout: (layout: '1' | '4') => set({ chartLayout: layout }),

  // 4画面のミニ枠（メインでない枠）の表示時間軸を変更。メイン枠が指定された場合は
  // 通常のメイン時間軸切替として扱う（setTimeframeに委譲、データ再取得を伴うため）
  setQuadTimeframe: (slot: number, sec: TimeframeSec) => {
    const { quadTimeframes, quadMainSlot } = get();
    if (slot === quadMainSlot) { void get().setTimeframe(sec); return; }
    const next = quadTimeframes.slice();
    next[slot] = sec;
    saveQuad(next, quadMainSlot);
    set({ quadTimeframes: next });
  },

  // ミニ枠をクリックしてメイン（操作可能パネル）に昇格。枠の時間軸をそのままメインに引き継ぐ
  promoteSlotToMain: (slot: number) => {
    const { quadTimeframes } = get();
    set({ quadMainSlot: slot });
    saveQuad(quadTimeframes, slot);
    void get().setTimeframe(quadTimeframes[slot]);
  },

  // 4画面時、十字カーソルの同期表示用。実マウス操作しているパネル（sourceId）と時刻を共有し、
  // 他パネルはこの時刻に`setCrosshairPosition`で追従表示する
  setCrosshair: (sourceId: string | null, time: number | null) => set({ crosshairSourceId: sourceId, crosshairTime: time }),
  clearError: () => set({ error: null }),
}));

// ── セレクタ ───────────────────────────────────────────────────────────────

export const selectUnrealizedPnL = (state: TraderState): number => {
  const c = state.candles[state.cursor];
  if (!c || state.positions.length === 0) return 0;
  return state.positions.reduce((sum, pos) => {
    const dir = pos.side === 'BUY' ? 1 : -1;
    return sum + (c.close - pos.openPrice) * pos.lots * dir;
  }, 0);
};

export const selectPositionPnL = (state: TraderState, id: number): number => {
  const pos = state.positions.find(p => p.id === id);
  const c = state.candles[state.cursor];
  if (!pos || !c) return 0;
  const dir = pos.side === 'BUY' ? 1 : -1;
  return (c.close - pos.openPrice) * pos.lots * dir;
};
