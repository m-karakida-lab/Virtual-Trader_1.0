import { create } from 'zustand';
import type { Candle, Position, ClosedTrade, PendingOrder, OrderType, Side, TimeframeSec, ChartLayout, DrawnLine, DrawnVLine, DrawnRect, DrawnTrendLine, DrawnChannel, DrawnArrow, DrawnBrush, DrawnText, LineDash, LineWidth, LineSelection, MagnetMode, TextFontSize, TextBorderStyle } from '../types';
import { LINE_COLORS, TIMEFRAMES, DEFAULT_BRUSH_SMOOTHING, HIDABLE_TIMEFRAMES, timeframeHideKey, isHiddenTimeframesVisibleAt } from '../types';
import { initDuckDB, loadCSVFiles, queryCandles } from '../lib/duckdb';
import { detectQuoteCurrency, detectPairSymbol } from '../lib/currency';
import { splitVtdBundle, buildVtdBundle } from '../lib/vtd';
import { writeToHandle } from '../lib/openHistory';
import { findBucketIndexContaining, buildPartialCandle } from '../lib/partialCandle';

const DEFAULT_INITIAL_BALANCE = 1_000_000;

// 水平線・垂直線・四角形のUndo用スナップショット。lines/vlines/rectsはどの操作でも
// 必ず新しい配列を作る（他要素をmutateしない）ため、参照をそのまま保持するだけでよい
interface DrawSnapshot {
  lines: DrawnLine[];
  vlines: DrawnVLine[];
  rects: DrawnRect[];
  trendLines: DrawnTrendLine[];
  channels: DrawnChannel[];
  arrows: DrawnArrow[];
  brushes: DrawnBrush[];
  texts: DrawnText[];
  nextLineId: number;
  nextVLineId: number;
  nextRectId: number;
  nextTrendLineId: number;
  nextChannelId: number;
  nextArrowId: number;
  nextBrushId: number;
  nextTextId: number;
}
const MAX_DRAW_UNDO = 50;

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

// 1画面/4画面の表示レイアウトは localStorage に記憶し、次回起動時も前回の状態から始める
const CHART_LAYOUT_STORAGE_KEY = 'vt:chartLayout';

function loadSavedChartLayout(): ChartLayout {
  try {
    const v = localStorage.getItem(CHART_LAYOUT_STORAGE_KEY);
    return v === '1' || v === '3' ? v : '4';
  } catch {
    return '4';
  }
}

function saveChartLayout(layout: ChartLayout): void {
  try {
    localStorage.setItem(CHART_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // localStorage が使えない場合は無視
  }
}

// 3画面の枠配置パターン。'left'=左1枠（縦通し）+右上下2枠、'top'=上1枠（横通し）+下左右2枠。
// どちらのパターンでも枠0が「大きい方の枠」を指す（quad3Timeframes/quad3MainSlotはパターン間で共有）
const QUAD3_PATTERN_STORAGE_KEY = 'vt:quad3pattern';

function loadSavedQuad3Pattern(): 'left' | 'top' {
  try {
    return localStorage.getItem(QUAD3_PATTERN_STORAGE_KEY) === 'top' ? 'top' : 'left';
  } catch {
    return 'left';
  }
}

function saveQuad3Pattern(pattern: 'left' | 'top'): void {
  try {
    localStorage.setItem(QUAD3_PATTERN_STORAGE_KEY, pattern);
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

// 水平線の右端価格ラベル・垂直線の上端日付ラベルの表示ON/OFF。線ごとではなく全体設定
// （ヒアリング済み）。デフォルトはどちらも表示ON（従来の水平線の見た目のまま）
const LINE_LABELS_STORAGE_KEY = 'vt:lineLabels';

function loadSavedLineLabels(): { showHLinePriceLabel: boolean; showVLineDateLabel: boolean } {
  try {
    const raw = localStorage.getItem(LINE_LABELS_STORAGE_KEY);
    if (!raw) throw new Error('no saved line labels');
    const parsed = JSON.parse(raw);
    return {
      showHLinePriceLabel: parsed.showHLinePriceLabel !== false,
      showVLineDateLabel: parsed.showVLineDateLabel !== false,
    };
  } catch {
    return { showHLinePriceLabel: true, showVLineDateLabel: true };
  }
}

function saveLineLabels(showHLinePriceLabel: boolean, showVLineDateLabel: boolean): void {
  try {
    localStorage.setItem(LINE_LABELS_STORAGE_KEY, JSON.stringify({ showHLinePriceLabel, showVLineDateLabel }));
  } catch {
    // localStorage が使えない場合は無視
  }
}

// 描画物（水平線・垂直線・四角形・トレンドライン・平行チャネル・矢印・ブラシ・テキスト）を
// 新規配置する時のデフォルトスタイル（各種Draft）。パレットで変更するたびlocalStorageへ記憶し、
// 次回起動時も引き継ぐ。水平線・垂直線は元々lineDraftを共有する設計のまま（分離しない）
const DRAW_DRAFTS_STORAGE_KEY = 'vt:drawDrafts';

interface DrawDrafts {
  lineDraft: { color: string; dash: LineDash; width: LineWidth };
  rectDraft: { color: string; dash: LineDash; width: LineWidth };
  trendLineDraft: { color: string; dash: LineDash; width: LineWidth };
  channelDraft: { color: string; dash: LineDash; width: LineWidth };
  arrowDraft: { color: string; dash: LineDash; width: LineWidth };
  brushDraft: { color: string; width: LineWidth; smoothing: number };
  textDraft: { color: string; fontSize: TextFontSize; border: TextBorderStyle };
}

function defaultDrawDrafts(): DrawDrafts {
  return {
    lineDraft: { color: '#e0e0e0', dash: 'solid', width: 2 },
    rectDraft: { color: LINE_COLORS[3], dash: 'solid', width: 2 }, // パレットにある青（#42a5f5）
    trendLineDraft: { color: LINE_COLORS[3], dash: 'solid', width: 2 },
    channelDraft: { color: LINE_COLORS[3], dash: 'solid', width: 2 },
    arrowDraft: { color: LINE_COLORS[3], dash: 'solid', width: 2 },
    brushDraft: { color: LINE_COLORS[3], width: 2, smoothing: DEFAULT_BRUSH_SMOOTHING },
    textDraft: { color: '#e0e0e0', fontSize: 18, border: 'solid' },
  };
}

function loadSavedDrawDrafts(): DrawDrafts {
  const defaults = defaultDrawDrafts();
  try {
    const raw = localStorage.getItem(DRAW_DRAFTS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      lineDraft: { ...defaults.lineDraft, ...parsed.lineDraft },
      rectDraft: { ...defaults.rectDraft, ...parsed.rectDraft },
      trendLineDraft: { ...defaults.trendLineDraft, ...parsed.trendLineDraft },
      channelDraft: { ...defaults.channelDraft, ...parsed.channelDraft },
      arrowDraft: { ...defaults.arrowDraft, ...parsed.arrowDraft },
      brushDraft: { ...defaults.brushDraft, ...parsed.brushDraft },
      textDraft: { ...defaults.textDraft, ...parsed.textDraft },
    };
  } catch {
    return defaults;
  }
}

function saveDrawDrafts(drafts: DrawDrafts): void {
  try {
    localStorage.setItem(DRAW_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // localStorage が使えない場合は無視
  }
}

function pickDrawDrafts(s: DrawDrafts): DrawDrafts {
  const { lineDraft, rectDraft, trendLineDraft, channelDraft, arrowDraft, brushDraft, textDraft } = s;
  return { lineDraft, rectDraft, trendLineDraft, channelDraft, arrowDraft, brushDraft, textDraft };
}

// 3画面/4画面レイアウトの「どの枠にどの時間軸を表示するか」（枠の位置は固定、中身の時間軸と
// メイン枠だけユーザーが選べる）は、3画面と4画面で完全に別管理（vt:quad3 / vt:quad4）。
// 切り替えてもお互いの状態に影響しない。デフォルトは共に 15m・1H・4H(・1D)
const QUAD4_STORAGE_KEY = 'vt:quad4';
const QUAD3_STORAGE_KEY = 'vt:quad3';
const DEFAULT_QUAD4_TIMEFRAMES: TimeframeSec[] = [900, 3600, 14400, 86400]; // 左上/左下/右上/右下
const DEFAULT_QUAD3_TIMEFRAMES: TimeframeSec[] = [900, 3600, 14400]; // 左（縦通し）/右上/右下

function isTimeframeSec(v: unknown): v is TimeframeSec {
  return typeof v === 'number' && TIMEFRAMES.some(tf => tf.sec === v);
}

// vtd読込時、保存されていた再生位置（足の時刻）に最も近いcursorを求める。
// candles[i].time <= targetTime を満たす最大のiを二分探索で返す（無ければ0）
function findCursorForTime(candles: Candle[], targetTime: number): number {
  let lo = 0, hi = candles.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= targetTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function loadSavedQuad(key: string, defaults: TimeframeSec[]): { timeframes: TimeframeSec[]; mainSlot: number } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('no saved quad');
    const parsed = JSON.parse(raw);
    const tfs = parsed.timeframes;
    if (!Array.isArray(tfs) || tfs.length !== defaults.length || !tfs.every(isTimeframeSec)) {
      throw new Error('invalid timeframes');
    }
    const slot = Number(parsed.mainSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= defaults.length) throw new Error('invalid mainSlot');
    return { timeframes: tfs, mainSlot: slot };
  } catch {
    return { timeframes: defaults, mainSlot: 0 };
  }
}

function saveQuad(key: string, timeframes: TimeframeSec[], mainSlot: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ timeframes, mainSlot }));
  } catch {
    // localStorage が使えない場合は無視
  }
}

// 起動時に必要な3画面/4画面の状態をまとめて読み込む。preMultiLayoutは1画面のままlocalStorageに
// 保存されていた場合に直前のマルチ画面レイアウトを復元できないため、その時は4画面を既定にする
// （preMultiLayout自体を1画面時は更新しない仕様と同じ簡略化）
function loadInitialQuadState() {
  const chartLayout = loadSavedChartLayout();
  const quad4 = loadSavedQuad(QUAD4_STORAGE_KEY, DEFAULT_QUAD4_TIMEFRAMES);
  const quad3 = loadSavedQuad(QUAD3_STORAGE_KEY, DEFAULT_QUAD3_TIMEFRAMES);
  const preMultiLayout: '3' | '4' = chartLayout === '3' ? '3' : '4';
  const active = chartLayout === '1' ? preMultiLayout : chartLayout;
  const timeframeSec = active === '3' ? quad3.timeframes[quad3.mainSlot] : quad4.timeframes[quad4.mainSlot];
  return { chartLayout, preMultiLayout, quad4, quad3, timeframeSec, active };
}

const initialQuadState = loadInitialQuadState();

interface TraderState {
  isLoaded: boolean;
  isLoading: boolean;
  loadingMsg: string;
  candles: Candle[];
  timeframeSec: TimeframeSec;
  cursor: number;
  // 「今」の時刻（candles[cursor].time + timeframeSec）を、時間足を切り替えても
  // 見失わないよう保持する。advance/stepBack/jumpToTime等の実際のカーソル移動の
  // たびに現在のcursorに合わせて更新し、setTimeframe（メイン時間足の切替・パネル
  // 昇格）ではこの値を変えない——切替は「今の瞬間」を変えない見た目の変更でしかない。
  // データ開示境界（新しい時間足でどのバケットを形成中とみなすか）の判定に使う
  mainRevealedUntil: number | null;
  // 画面ヘッダーの現在時刻表示に使う値。mainRevealedUntilと違い+timeframeSecしない
  // 生の時刻（＝実際にカーソルを動かした時点のcandles[cursor].time）を保持する。
  // 時間足を切り替えると新しい時間足のバケット開始時刻（例: 1Dなら07:00始まり等）に
  // 丸まって見えてしまい、「切り替えても今の時刻の表示は変わらないでほしい」という
  // 要望に反するため、表示専用の値として切替をまたいで据え置く
  mainDisplayTime: number | null;
  // 非メイン各パネルが自分の「形成中の足」を自前集計する際の元データ。実際にカーソルを
  // 動かした時点のcandles/cursorをそのまま保持し、setTimeframe（メイン切替）では
  // 更新しない——メイン切替直後は新しいcandlesがまだ粗い時間足（例:1D）のことがあり、
  // それを元データにすると他の非メインパネル（例:4H）が自分より粗いデータからは
  // 形成中の足を再集計できず、切替前まで正しく出ていた形成中の足が急に消えて
  // 1つ前の確定済みバケットまで戻って見えてしまう（実際に指摘を受けて判明）
  finestSourceCandles: Candle[];
  finestSourceCursor: number;
  initialBalance: number; // CSV読み込み・リセット時の開始残高
  isInitialBalanceCustom: boolean; // ユーザーが手動で初期残高を変更したか（trueなら通貨切替時の自動調整をしない）
  balance: number;
  positions: Position[];
  pendingOrders: PendingOrder[]; // 指値・逆指値の未約定注文
  nextOrderId: number;
  closedTrades: ClosedTrade[]; // 決済済みトレード履歴（チャート上のマーカー表示用）
  quoteCurrency: string; // 残高・損益の単位（読み込んだペアのクオート通貨。例: EURUSD→USD）
  symbol: string; // 読み込んだ通貨ペアのシンボル（例: "USDJPY"）。チャートヘッダー表示用
  rawCsvText: string | null; // 保存機能用。単一ファイル読み込み時のみ保持（複数ファイルは非対応）
  rawFileHandle: FileSystemFileHandle | null; // File System Access APIで開いた時のみ保持。上書き保存に使う
  rawFileIsBundle: boolean; // rawFileHandleが指すファイルが既にvtdバンドル（マーカー入り）だったか。
                             // falseなら素のCSVを開いた直後で、上書きすると元データが壊れるため直接書き込みを許可しない
  loadedFileLabel: string; // ファイル選択欄の代わりに表示するラベル（バンドル検出時は.vtd表記に正規化、複数ファイルは件数表示）
  // 手動で「上書き保存」を1回成功させた後だけtrueになる（自動保存はこれをトリガーに開始する。
  // ファイルを開いただけの状態では自動で書き込みを始めない、というユーザーとの合意に基づくガード）。
  // 新しいファイルを読み込むとfalseに戻る。localStorageには永続化しない
  autoSaveArmed: boolean;
  lastSavedBundleText: string | null; // 直近の保存内容。自動保存は前回保存時から変化が無ければ書き込みをスキップする
  lastSavedAt: number | null; // 直近の保存（手動上書き/自動どちらも）が成功したUnixミリ秒。UIの「最終保存」表示用
  lots: number;          // 発注ロット数（固定モード時に使用）
  lotMode: 'fixed' | 'risk'; // ロット指定方法
  riskPercent: number;       // リスクモード時: 残高に対する許容損失の割合（%）
  nextId: number;        // ポジション ID カウンタ
  orderType: OrderType;  // 発注パネルで選択中の注文種別
  draftPrice: number | null; // 指値・逆指値の発注価格（draft）
  draftTP: number | null;    // 発注時の TP（draft）
  draftSL: number | null;    // 発注時の SL（draft）
  // 直近の発注で「価格・TP・SLがエントリー価格（成行なら約定値、指値/逆指値ならdraftPrice）
  // から何%離れていたか」を比率で覚えておく。発注パネルを開いた時（＋注文種別/方向を
  // 切り替えた時）、この比率を現在値に適用して価格/TP/SLへ予想値として仮入力する
  // （毎回同じような距離感で発注する使い方が多いはずなので、都度手入力する手間を減らす狙い）。
  // 成行/指値/逆指値 × BUY/SELL の組み合わせごとに別々に覚える（`${orderType}:${side}`キー）。
  // 例えばBUYの成行とSELLの逆指値で全く違う値幅を使う運用でも、それぞれ独立して再現できる
  lastOrderRatiosByKey: Record<string, { priceRatio: number | null; tpRatio: number | null; slRatio: number | null }>;
  pickTarget: 'price' | 'tp' | 'sl' | null; // チャートクリックで price/tp/sl に値を入れるモード
  // 「日足の特定の足を指して他の時間足の同じ時刻へジャンプする」ツール。ONの間に
  // どれか1つのパネルで足をクリックすると、クリックしなかった他の枠だけがその時刻を
  // 中心に表示位置を移動する（クリックした枠自身はズームも位置も変えない）
  isJumpSync: boolean;
  jumpSyncSignal: number;   // jumpSyncTo が呼ばれるたびに増える
  jumpSyncTarget: number;   // ジャンプ先の時刻（Unix秒）
  jumpSyncSourceId: string | null; // クリックが発生したパネルのmySourceId（'main'かslot番号の文字列）。このID自身は移動対象から除外する
  error: string | null;
  isPlaying: boolean;
  speed: number;         // 1〜20
  lines: DrawnLine[];
  nextLineId: number;
  isDrawingLine: boolean;
  vlines: DrawnVLine[];
  nextVLineId: number;
  isDrawingVLine: boolean;
  showHLinePriceLabel: boolean; // 水平線の右端価格ラベルON/OFF（全線共通、localStorageに記憶）
  showVLineDateLabel: boolean;  // 垂直線の上端日付ラベルON/OFF（全線共通、localStorageに記憶）
  isMeasuring: boolean;
  rects: DrawnRect[];
  nextRectId: number;
  isDrawingRect: boolean;
  trendLines: DrawnTrendLine[];
  nextTrendLineId: number;
  isDrawingTrendLine: boolean;
  channels: DrawnChannel[];
  nextChannelId: number;
  isDrawingChannel: boolean;
  arrows: DrawnArrow[];
  nextArrowId: number;
  isDrawingArrow: boolean;
  brushes: DrawnBrush[];
  nextBrushId: number;
  isDrawingBrush: boolean;
  texts: DrawnText[];
  nextTextId: number;
  isDrawingText: boolean;
  drawHistory: DrawSnapshot[]; // 水平線・垂直線・四角形・トレンドライン・ブラシ・テキストのUndo用スナップショット（最新が末尾）
  // ON中は配置してもツールをOFFにせず、置いた図形も選択（編集モード）に入れない。
  // TradingViewの「連続描画」相当。他のisDrawingX等と違い描画ツールの切替では消えない
  // 独立した設定（ロック的な位置づけ）。デフォルトOFF
  continuousDrawing: boolean;
  magnetMode: MagnetMode; // 描画時に価格を足の高値/安値/始値/終値へ吸着させる強さ
  magnetStrength: Exclude<MagnetMode, 'off'>; // OFF→ON時に使う強さ（localStorageに記憶）
  selected: LineSelection | null; // 水平線・垂直線・四角形・トレンドライン・ブラシ・テキストのいずれか選択中の1つ
  lineDraft: { color: string; dash: LineDash; width: LineWidth };
  rectDraft: { color: string; dash: LineDash; width: LineWidth };
  trendLineDraft: { color: string; dash: LineDash; width: LineWidth };
  channelDraft: { color: string; dash: LineDash; width: LineWidth };
  arrowDraft: { color: string; dash: LineDash; width: LineWidth };
  brushDraft: { color: string; width: LineWidth; smoothing: number };
  textDraft: { color: string; fontSize: TextFontSize; border: TextBorderStyle };
  // パレットモード: ONの間、水平線・垂直線・四角形・トレンドライン・ブラシ・テキストをクリックして
  // 選択（編集モード）に入れるたびpaletteStyleの内容をその図形へ即座に反映する（一括塗り替え用）。
  // dash/widthは水平線・垂直線・四角形・トレンドライン、widthのみブラシ、fontSize/borderはテキスト専用（互いに無視し合う）
  paletteMode: boolean;
  paletteStyle: { color: string; dash: LineDash; width: LineWidth; fontSize: TextFontSize; border: TextBorderStyle };
  showEMA: boolean;
  showSMA: boolean;
  showBB: boolean;
  showCloud: boolean;
  showWeekLines: boolean;
  showSessions: boolean; // 東京/ロンドン/NYの取引時間帯を背景帯で表示するインジケータ
  overlaysHidden: boolean; // インジケータ・描画物（線/図形等）を一括で非表示にするトグル。データは消さない
  showHistoryPanel: boolean; // 取引履歴・損益グラフのパネル表示
  memoTradeId: number | null; // トレード日誌メモのポップアップ窓で開いている取引（閉じていればnull、永続化しない）
  // チャート上のエントリー/決済マーカー（トレード履歴）を時間足ごとに表示/非表示。
  // キーは時間足(sec)、値がfalseのものだけ非表示（未登録=表示）。時間足単位で管理する
  // ため、同じ時間足を複数パネルで表示していれば連動し、パネル自体の位置には紐付かない
  tradeMarkersVisible: Partial<Record<TimeframeSec, boolean>>;
  scrollToTradeId: number | null; // チャート上のトレードマーカーをクリックした時、取引履歴パネル側でこのidの行までスクロール＋ハイライトする（一度使ったらnullに戻す）
  orderPanelOpen: boolean; // 発注パネル（独立フローティング、OrderPanel.tsx）の開閉
  chartRightMargin: number;  // チャート右側の価格軸の実測幅(px)。フロートパネルの配置クランプ用
  chartBottomMargin: number; // チャート下部の時間軸の実測高さ(px)。フロートパネルの配置クランプ用
  fitSignal: number;  // fitToScreen が呼ばれるたびに増える（チャート側の fitContent 起動トリガ用）
  scrollToLatestSignal: number; // scrollToLatest が呼ばれるたびに増える（最新足を右寄せで表示するトリガ用）
  followLatest: boolean; // true の間、新しい足が現れるたびに右寄せ位置を保ち続ける（TradingViewの「リアルタイムに戻る」相当）。
                          // ユーザーが手動でパン/ズームしたら自動でfalseに戻す
  centerSignal: number; // centerOnTime が呼ばれるたびに増える
  centerTarget: number;  // centerOnTime の移動先（Unix秒）
  chartLayout: ChartLayout; // 1画面 / 3画面（左1枠+右上下2枠） / 4画面（2x2、いずれも時間軸別マルチチャート）
  preMultiLayout: '3' | '4'; // フルスクリーン(1画面)化する直前のマルチ画面レイアウト。解除時にこれへ戻す
  // 3画面と4画面は各枠の時間軸・メイン枠を完全に別管理し、切り替えてもお互いの状態を保つ
  quad4Timeframes: TimeframeSec[]; // 4画面の各枠（左上/左下/右上/右下）に表示する時間軸
  quad4MainSlot: number; // quad4Timeframes のうち、現在メイン（操作可能）になっている枠のインデックス
  quad3Timeframes: TimeframeSec[]; // 3画面の各枠（大きい枠/小さい枠2つ）に表示する時間軸。枠位置の意味はquad3Patternで変わる
  quad3MainSlot: number; // quad3Timeframes のうち、現在メイン（操作可能）になっている枠のインデックス
  quad3Pattern: 'left' | 'top'; // 3画面の枠配置。left=左1枠(縦通し)+右上下2枠、top=上1枠(横通し)+下左右2枠
  dataVersion: number; // CSV読み込みが完了するたびに増える（ミニチャートの再集計トリガ用）
  crosshairSourceId: string | null; // 4画面時、実際にマウスホバー中のパネルID（'main' またはミニ枠のslot番号文字列）
  crosshairTime: number | null; // ↑のパネルで十字カーソルが指している時刻（Unix秒）。他パネルはこの時刻に同期表示する
  // 4画面時、直近でmousedownした枠のslot番号。Delete/Undo/コピペ等のキーボード
  // ショートカットは、4インスタンス同時稼働でも「最後に操作した1枠だけ」に効かせるため
  // これと自分のslotを突き合わせてガードする（crosshairSourceIdとは別の目的の状態
  // なので混同しないこと。crosshairSourceIdはホバー起点、こちらはクリック起点）。
  // localStorageには永続化しない（セッション中の一時的なUI状態）
  activePanelSlot: number;

  setInitialBalance: (v: number) => void;
  resetAccount: () => void;
  loadFiles: (files: FileList | File[], fileHandle?: FileSystemFileHandle) => Promise<void>;
  saveChartFile: () => Promise<void>;
  autoSaveTick: () => Promise<void>; // 定期タイマー（App.tsx）から呼ばれる。armed/差分の判定含め自己完結
  setTimeframe: (sec: TimeframeSec, preloadedCandles?: Candle[]) => Promise<void>;
  advance: (steps?: number) => boolean; // steps本まとめて進める（再生のフレーム落ち補正用）。末尾に達したらfalse
  stepBack: () => boolean;
  jumpToTime: (targetSec: number, opts?: { rewind?: boolean }) => void;
  fitToScreen: () => void;
  scrollToLatest: () => void;
  setFollowLatest: (v: boolean) => void;
  centerOnTime: (time: number) => void;
  setOrderType: (t: OrderType) => void;
  setDraftPrice: (v: number | null) => void;
  setDraftTP: (v: number | null) => void;
  setDraftSL: (v: number | null) => void;
  clearDraft: () => void;
  togglePickTarget: (t: 'price' | 'tp' | 'sl') => void;
  pickPrice: (price: number) => void;
  toggleJumpSync: () => void;
  jumpSyncTo: (sourceId: string, time: number) => void;
  submitOrder: (side: Side, rrImage?: string) => boolean;
  // 発注後に裏で作った画像を、その取引（建玉/未約定注文/決済済み）へ後から付ける
  attachRrImage: (target: { kind: 'position' | 'order'; id: number }, image: string) => void; // 成立したらtrue（発注パネルを閉じる判断に使う）
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
  setLineDraft: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  addVLine: (time: number) => void;
  updateVLine: (id: number, patch: Partial<Omit<DrawnVLine, 'id'>>) => void;
  removeVLine: (id: number) => void;
  duplicateVLine: (id: number, newTime: number) => void;
  toggleDrawVLine: () => void;
  toggleHLinePriceLabel: () => void;
  toggleVLineDateLabel: () => void;
  toggleMeasure: () => void;
  addRect: (time1: number, price1: number, time2: number, price2: number) => void;
  updateRect: (id: number, patch: Partial<Omit<DrawnRect, 'id'>>) => void;
  removeRect: (id: number) => void;
  duplicateRect: (id: number, time1: number, price1: number, time2: number, price2: number) => void;
  toggleDrawRect: () => void;
  setRectDraft: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  addTrendLine: (time1: number, price1: number, time2: number, price2: number) => void;
  updateTrendLine: (id: number, patch: Partial<Omit<DrawnTrendLine, 'id'>>) => void;
  removeTrendLine: (id: number) => void;
  duplicateTrendLine: (id: number, time1: number, price1: number, time2: number, price2: number) => void;
  toggleDrawTrendLine: () => void;
  setTrendLineDraft: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  addChannel: (time1: number, price1: number, time2: number, price2: number, offset: number) => void;
  updateChannel: (id: number, patch: Partial<Omit<DrawnChannel, 'id'>>) => void;
  removeChannel: (id: number) => void;
  duplicateChannel: (id: number, time1: number, price1: number, time2: number, price2: number) => void;
  toggleDrawChannel: () => void;
  setChannelDraft: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  addArrow: (time1: number, price1: number, time2: number, price2: number) => void;
  updateArrow: (id: number, patch: Partial<Omit<DrawnArrow, 'id'>>) => void;
  removeArrow: (id: number) => void;
  duplicateArrow: (id: number, time1: number, price1: number, time2: number, price2: number) => void;
  toggleDrawArrow: () => void;
  setArrowDraft: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth }>) => void;
  addBrush: (points: { time: number; price: number }[], opts?: { shape?: 'triangle' | 'circle' }) => void;
  updateBrush: (id: number, patch: Partial<Omit<DrawnBrush, 'id'>>) => void;
  removeBrush: (id: number) => void;
  duplicateBrush: (id: number, points: { time: number; price: number }[]) => void;
  toggleDrawBrush: () => void;
  setBrushDraft: (patch: Partial<{ color: string; width: LineWidth; smoothing: number }>) => void;
  addText: (time: number, price: number, text: string) => void;
  updateText: (id: number, patch: Partial<Omit<DrawnText, 'id'>>) => void;
  removeText: (id: number) => void;
  duplicateText: (id: number, time: number, price: number) => void;
  toggleDrawText: () => void;
  setTextDraft: (patch: Partial<{ color: string; fontSize: TextFontSize; border: TextBorderStyle }>) => void;
  toggleContinuousDrawing: () => void;
  setTradeMemo: (id: number, memo: string) => void; // 決済済み取引のトレード日誌メモ（空文字で削除）
  // 指定の種類（水平線・垂直線・四角形・トレンドライン・平行チャネル・矢印・ブラシ・テキスト）
  // のうち、このtimeframeSecで今表示中のものだけを対象に「この時間足でのみ表示」にする
  // （対象外＝元から非表示だった図形には触らない）。パネルヘッダーの「この時間足のみ表示」用
  restrictKindToTimeframe: (kind: LineSelection['kind'], timeframeSec: TimeframeSec) => void;
  // restrictKindToTimeframeの逆。このtimeframeSecで表示中かつ他の時間足で非表示に制限されて
  // いるものだけを対象にhiddenTimeframesを空にして全時間足で表示に戻す
  showKindOnAllTimeframes: (kind: LineSelection['kind'], timeframeSec: TimeframeSec) => void;
  undo: () => void; // 水平線・垂直線・四角形・トレンドライン・矢印・ブラシ・テキストの直前の変更を1つ戻す
  setMagnetMode: (mode: MagnetMode) => void;
  toggleMagnet: () => void;
  selectLine: (target: LineSelection | null) => void;
  setPaletteStyle: (patch: Partial<{ color: string; dash: LineDash; width: LineWidth; fontSize: TextFontSize; border: TextBorderStyle }>) => void;
  toggleEMA: () => void;
  toggleSMA: () => void;
  toggleBB: () => void;
  toggleCloud: () => void;
  toggleOverlaysHidden: () => void;
  toggleWeekLines: () => void;
  toggleSessions: () => void;
  advanceToEnd: () => void;
  toggleHistoryPanel: () => void;
  setMemoTradeId: (id: number | null) => void;
  toggleTradeMarkersForTimeframe: (sec: TimeframeSec) => void;
  openHistoryForTrade: (tradeId: number) => void;
  setScrollToTradeId: (tradeId: number | null) => void;
  setOrderPanelOpen: (open: boolean) => void;
  setChartMargins: (right: number, bottom: number) => void;
  setChartLayout: (layout: ChartLayout) => void;
  toggleQuad3Pattern: () => void;
  setQuadTimeframe: (slot: number, sec: TimeframeSec) => void;
  promoteSlotToMain: (slot: number, preloadedCandles?: Candle[]) => void;
  setCrosshair: (sourceId: string | null, time: number | null) => void;
  setActivePanelSlot: (slot: number) => void;
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
            lots: order.lots, openTime: c.time, tp: order.tp, sl: order.sl, rrImage: order.rrImage,
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
            tp: pos.tp, sl: pos.sl, rrImage: pos.rrImage,
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

// 水平線・垂直線・四角形を変更する12個のアクション（追加/更新/削除/複製×3種）の先頭で
// 必ず呼ぶ。変更前の状態をUndoスタックに積む（ドラッグ中の逐次プレビューはstoreを経由
// せずチャート側で直接動かしているため、ここではmouseup等の1コミット＝1手にしかならない）
function pushDrawHistory(get: () => TraderState, set: (fn: (s: TraderState) => Partial<TraderState>) => void): void {
  const { lines, vlines, rects, trendLines, channels, arrows, brushes, texts, nextLineId, nextVLineId, nextRectId, nextTrendLineId, nextChannelId, nextArrowId, nextBrushId, nextTextId, drawHistory } = get();
  const snapshot: DrawSnapshot = { lines, vlines, rects, trendLines, channels, arrows, brushes, texts, nextLineId, nextVLineId, nextRectId, nextTrendLineId, nextChannelId, nextArrowId, nextBrushId, nextTextId };
  set(() => ({ drawHistory: [...drawHistory, snapshot].slice(-MAX_DRAW_UNDO) }));
}

// 描画ツールをONにする（armする）瞬間に呼ぶ。既存の選択（＝別図形の編集パレット）を
// 残したままだと、「配置前に太さ等を決める」ための専用パレット（PalettePanel.tsx側の
// armedKind判定）に切り替わらず、古い選択中図形のパレットが出続けてしまうため
function armPatch(next: boolean): Partial<TraderState> {
  return next ? { selected: null, paletteMode: false } : {};
}

// パレットモード中に、選択中の図形へ現在のpaletteStyleを書き込む（色・線種・太さ）。
// パレット側の設定を変えた時（setPaletteStyle）から呼ばれる。
// 「選択しただけ」では図形側は変えない（syncPaletteStyleFromと役割が逆）。
// テキストは線種・太さの代わりに文字サイズ・枠線スタイルを持つ。ブラシは色と太さのみ
function applyPaletteStyleTo(get: () => TraderState, target: LineSelection): void {
  const { paletteStyle } = get();
  if (target.kind === 'h') get().updateLine(target.id, paletteStyle);
  else if (target.kind === 'v') get().updateVLine(target.id, paletteStyle);
  else if (target.kind === 'rect') get().updateRect(target.id, paletteStyle);
  else if (target.kind === 'trend') get().updateTrendLine(target.id, paletteStyle);
  else if (target.kind === 'channel') get().updateChannel(target.id, paletteStyle);
  else if (target.kind === 'arrow') get().updateArrow(target.id, paletteStyle);
  else if (target.kind === 'brush') get().updateBrush(target.id, { color: paletteStyle.color, width: paletteStyle.width });
  else get().updateText(target.id, { color: paletteStyle.color, fontSize: paletteStyle.fontSize, border: paletteStyle.border });
}

// パレットモードで図形を選択（編集モードに入る）した時に、その図形の現在のスタイルを
// パレット側へ取り込む（選択しただけで図形の見た目が変わらないように）。
// テキストは色・文字サイズ・枠線スタイルを取り込み、ブラシは色・太さだけを取り込む
// （線種は直前の値を維持する。水平線・垂直線・四角形・トレンドラインにしか適用されないため）
function syncPaletteStyleFrom(set: (fn: (s: TraderState) => Partial<TraderState>) => void, get: () => TraderState, target: LineSelection): void {
  const s = get();
  if (target.kind === 'h') {
    const line = s.lines.find(l => l.id === target.id);
    if (line) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: line.color, dash: line.dash, width: line.width } }));
  } else if (target.kind === 'v') {
    const v = s.vlines.find(vv => vv.id === target.id);
    if (v) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: v.color, dash: v.dash, width: v.width } }));
  } else if (target.kind === 'rect') {
    const r = s.rects.find(rr => rr.id === target.id);
    if (r) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: r.color, dash: r.dash, width: r.width } }));
  } else if (target.kind === 'trend') {
    const tl = s.trendLines.find(tt => tt.id === target.id);
    if (tl) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: tl.color, dash: tl.dash, width: tl.width } }));
  } else if (target.kind === 'channel') {
    const ch = s.channels.find(cc => cc.id === target.id);
    if (ch) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: ch.color, dash: ch.dash, width: ch.width } }));
  } else if (target.kind === 'arrow') {
    const ar = s.arrows.find(aa => aa.id === target.id);
    if (ar) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: ar.color, dash: ar.dash, width: ar.width } }));
  } else if (target.kind === 'brush') {
    const b = s.brushes.find(bb => bb.id === target.id);
    if (b) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: b.color, width: b.width } }));
  } else {
    const t = s.texts.find(tt => tt.id === target.id);
    if (t) set(prev => ({ paletteStyle: { ...prev.paletteStyle, color: t.color, fontSize: t.fontSize, border: t.border } }));
  }
}

export const useTraderStore = create<TraderState>((set, get) => ({
  isLoaded: false,
  isLoading: false,
  loadingMsg: '',
  candles: [],
  cursor: 0,
  mainRevealedUntil: null,
  mainDisplayTime: null,
  finestSourceCandles: [],
  finestSourceCursor: 0,
  initialBalance: DEFAULT_INITIAL_BALANCE,
  isInitialBalanceCustom: false,
  balance: DEFAULT_INITIAL_BALANCE,
  positions: [],
  pendingOrders: [],
  nextOrderId: 1,
  closedTrades: [],
  quoteCurrency: 'JPY',
  symbol: '',
  rawCsvText: null,
  rawFileHandle: null,
  rawFileIsBundle: false,
  autoSaveArmed: false,
  lastSavedBundleText: null,
  lastSavedAt: null,
  loadedFileLabel: '選択されていません',
  lots: 10_000,
  lotMode: 'risk',
  riskPercent: 3,
  nextId: 1,
  orderType: 'market',
  draftPrice: null,
  draftTP: null,
  draftSL: null,
  lastOrderRatiosByKey: {},
  pickTarget: null,
  isJumpSync: false,
  jumpSyncSignal: 0,
  jumpSyncTarget: 0,
  jumpSyncSourceId: null,
  error: null,
  isPlaying: false,
  speed: loadSavedSpeed(),
  lines: [],
  nextLineId: 1,
  isDrawingLine: false,
  vlines: [],
  nextVLineId: 1,
  isDrawingVLine: false,
  ...loadSavedLineLabels(),
  isMeasuring: false,
  rects: [],
  nextRectId: 1,
  isDrawingRect: false,
  trendLines: [],
  nextTrendLineId: 1,
  isDrawingTrendLine: false,
  channels: [],
  nextChannelId: 1,
  isDrawingChannel: false,
  arrows: [],
  nextArrowId: 1,
  isDrawingArrow: false,
  brushes: [],
  nextBrushId: 1,
  isDrawingBrush: false,
  texts: [],
  nextTextId: 1,
  isDrawingText: false,
  continuousDrawing: false,
  drawHistory: [],
  magnetMode: loadSavedMagnetStrength(), // デフォルトでON（起動のたびON、強さは前回記憶した方から始まる）
  magnetStrength: loadSavedMagnetStrength(),
  selected: null,
  ...loadSavedDrawDrafts(),
  paletteMode: false,
  paletteStyle: { color: '#42a5f5', dash: 'solid', width: 2, fontSize: 18, border: 'solid' },
  showEMA: false,
  showSMA: true,
  showBB: true,
  showCloud: true,
  overlaysHidden: false,
  showWeekLines: true,
  showSessions: true,
  showHistoryPanel: false,
  memoTradeId: null,
  tradeMarkersVisible: {},
  scrollToTradeId: null,
  orderPanelOpen: false,
  chartRightMargin: 60,
  chartBottomMargin: 28,
  fitSignal: 0,
  scrollToLatestSignal: 0,
  followLatest: false,
  centerSignal: 0,
  centerTarget: 0,
  chartLayout: initialQuadState.chartLayout,
  preMultiLayout: initialQuadState.preMultiLayout,
  quad4Timeframes: initialQuadState.quad4.timeframes,
  quad4MainSlot: initialQuadState.quad4.mainSlot,
  quad3Timeframes: initialQuadState.quad3.timeframes,
  quad3MainSlot: initialQuadState.quad3.mainSlot,
  quad3Pattern: loadSavedQuad3Pattern(),
  timeframeSec: initialQuadState.timeframeSec,
  dataVersion: 0,
  crosshairSourceId: null,
  crosshairTime: null,
  // 起動直後はメイン枠にキーボードショートカットが効くようにしておく
  // （実際にどこかのパネルをクリックした時点でそちらに切り替わる）
  activePanelSlot: initialQuadState.active === '3' ? initialQuadState.quad3.mainSlot : initialQuadState.quad4.mainSlot,

  loadFiles: async (files: FileList | File[], fileHandle?: FileSystemFileHandle) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    set({ isLoading: true, error: null, loadingMsg: '初期化中...' });
    try {
      // 保存済みバンドル（CSV+描画データ）の検出は単一ファイル読み込みのみ対応する。
      // 複数ファイル（年ごとの大容量CSVの結合読み込み）まで対応すると、DuckDB用の
      // arrayBuffer読み込みと二重にテキストを読むことになり大容量時に遅くなるため
      let filesToLoad = fileArray;
      let drawings: ReturnType<typeof splitVtdBundle>['drawings'] = null;
      let rawCsvText: string | null = null;
      if (fileArray.length === 1) {
        const text = await fileArray[0].text();
        const split = splitVtdBundle(text);
        drawings = split.drawings;
        rawCsvText = split.csvText;
        filesToLoad = [new File([split.csvText], fileArray[0].name, { type: 'text/csv' })];
      }

      const db = await initDuckDB();
      await loadCSVFiles(db, filesToLoad, (current, total, name) => {
        set({ loadingMsg: `${current}/${total}: ${name}` });
      });
      set({ loadingMsg: '集計中...' });
      const { timeframeSec, initialBalance, isInitialBalanceCustom } = get();
      const candles = await queryCandles(db, timeframeSec);
      const quoteCurrency = detectQuoteCurrency(fileArray[0].name);
      const symbol = detectPairSymbol(fileArray[0].name);
      // ユーザーが初期残高を手動で変更していなければ、クオート通貨に応じたデフォルトに合わせる
      const newInitialBalance = isInitialBalanceCustom ? initialBalance : defaultBalanceFor(quoteCurrency);
      const nextIdOf = (arr: { id: number }[]): number => arr.reduce((m, x) => Math.max(m, x.id), 0) + 1;
      // fontSize/borderは文字サイズ・枠線カスタマイズ追加より前に保存されたvtdファイルには
      // 存在しないため、無い場合だけデフォルト値で補う
      const texts: DrawnText[] = (drawings?.texts ?? []).map(t => ({ fontSize: 18, border: 'solid', ...(t as Partial<DrawnText>) } as DrawnText));
      // 建玉中のポジション・未約定注文は保存対象外（「その時点のCSV+描画だけを純粋に保つ」方針）
      // なので常に空に戻すが、決済済み取引履歴は復元する。残高は初期残高からではなく
      // 「初期残高＋復元した取引の損益合計」にして、履歴と矛盾しない値にする
      const restoredTrades = drawings?.closedTrades ?? [];
      const restoredBalance = newInitialBalance + restoredTrades.reduce((sum, t) => sum + t.pnl, 0);
      // 保存されていた再生位置（足の時刻）を、今回読み込んだ時間軸のcandlesに引き直す。
      // 未保存（旧形式のファイルや素のCSV）は従来通り先頭から
      const restoredCursor = drawings?.cursorTime !== undefined && candles.length > 0
        ? findCursorForTime(candles, drawings.cursorTime)
        : 0;
      set({
        candles, cursor: restoredCursor,
        mainRevealedUntil: candles[restoredCursor] !== undefined ? candles[restoredCursor].time + timeframeSec : null,
        mainDisplayTime: candles[restoredCursor] !== undefined ? candles[restoredCursor].time : null,
        finestSourceCandles: candles, finestSourceCursor: restoredCursor,
        isLoaded: true,
        isLoading: false, loadingMsg: `✓ ${candles.length.toLocaleString()}本 読み込み完了`,
        balance: restoredBalance, initialBalance: newInitialBalance,
        positions: [], pendingOrders: [], nextOrderId: 1,
        closedTrades: restoredTrades, nextId: nextIdOf(restoredTrades),
        isPlaying: false,
        lines: drawings?.lines ?? [], nextLineId: nextIdOf(drawings?.lines ?? []),
        vlines: drawings?.vlines ?? [], nextVLineId: nextIdOf(drawings?.vlines ?? []),
        rects: drawings?.rects ?? [], nextRectId: nextIdOf(drawings?.rects ?? []),
        trendLines: drawings?.trendLines ?? [], nextTrendLineId: nextIdOf(drawings?.trendLines ?? []),
        channels: drawings?.channels ?? [], nextChannelId: nextIdOf(drawings?.channels ?? []),
        arrows: drawings?.arrows ?? [], nextArrowId: nextIdOf(drawings?.arrows ?? []),
        brushes: drawings?.brushes ?? [], nextBrushId: nextIdOf(drawings?.brushes ?? []),
        texts, nextTextId: nextIdOf(texts),
        selected: null, drawHistory: [],
        quoteCurrency, symbol,
        rawCsvText,
        rawFileHandle: fileArray.length === 1 ? (fileHandle ?? null) : null,
        // drawings!==null は、開いたファイル自体が既にvtdバンドル（マーカー入り）だったことを意味する。
        // 素のCSVを開いただけの場合はfalseにし、上書き保存で元データを壊さないようにする
        rawFileIsBundle: fileArray.length === 1 && drawings !== null,
        // 新しいファイルを開いたら自動保存は必ず未武装に戻す（手動で上書き保存するまで始めない）
        autoSaveArmed: false,
        lastSavedBundleText: null,
        lastSavedAt: null,
        // ファイル選択欄はOS/ブラウザ標準のファイル名表示に頼らず、この文字列を自前で出す。
        // バンドル（描画データ入り）と分かっているものは、実際の拡張子に関わらず.vtd表記に揃える
        loadedFileLabel: fileArray.length === 1
          ? (drawings !== null ? fileArray[0].name.replace(/\.(csv|vtd)$/i, '') + '.vtd' : fileArray[0].name)
          : `${fileArray.length}件のCSV`,
        dataVersion: get().dataVersion + 1,
      });
      setTimeout(() => {
        if (get().loadingMsg.startsWith('✓')) set({ loadingMsg: '' });
      }, 5000);
    } catch (e) {
      set({ error: String(e), isLoading: false, loadingMsg: '' });
    }
  },

  // 水平線・垂直線・四角形を、読み込んだ元CSVと1つのファイルにまとめて保存する。
  // 中身は実質CSV+JSONトレーラーだが、素のデータCSVと見分けが付くよう拡張子は.vtdにする
  // （read_csv側は拡張子を見ないため、読込時に.csv/.vtdどちらでも中身のマーカーだけで判定する）。
  // rawCsvTextは単一ファイル読み込み時のみ保持しているため、複数ファイル読み込み後は何もしない。
  // 直接上書き（writeToHandle）が許されるのは、開いたファイル自体が既にvtdバンドルだった場合
  // （rawFileIsBundle）だけ。素のCSVを開んだ直後にrawFileHandleへ書き込むと、そのCSVの中身が
  // 黙ってバンドル形式に書き換わってしまう（実際に踏んだ不具合: 拡張子は.csvのままなのに
  // 中身だけvtdになり、しかも表示は「.vtdに保存しました」で紛らわしかった）。
  // 素のCSVの初回保存は必ずダウンロード（新しい.vtdファイルとして書き出す）に倒す
  saveChartFile: async () => {
    const { rawCsvText, rawFileHandle, rawFileIsBundle, loadedFileLabel, lines, vlines, rects, trendLines, channels, arrows, brushes, texts, closedTrades, candles, cursor } = get();
    if (rawCsvText === null) return;
    const cursorTime = candles[cursor]?.time;
    const bundle = buildVtdBundle(rawCsvText, { lines, vlines, rects, trendLines, channels, arrows, brushes, texts, closedTrades, cursorTime });

    if (rawFileHandle !== null && rawFileIsBundle) {
      try {
        await writeToHandle(rawFileHandle, bundle);
        // 手動での上書き保存が1回成功した時点で自動保存を武装する（ユーザーとの合意通り、
        // ファイルを開いただけでは自動保存を始めない）
        set({ loadingMsg: `✓ ${loadedFileLabel} に上書き保存しました`, autoSaveArmed: true, lastSavedBundleText: bundle, lastSavedAt: Date.now() });
        setTimeout(() => {
          if (get().loadingMsg.startsWith('✓')) set({ loadingMsg: '' });
        }, 4000);
        return;
      } catch (e) {
        set({ error: `上書き保存に失敗したためダウンロードします: ${String(e)}` });
      }
    }

    const blob = new Blob([bundle], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = loadedFileLabel.replace(/\.(csv|vtd)$/i, '') + '.vtd';
    a.click();
    URL.revokeObjectURL(url);
  },

  // 上書き保存が1回成功した後、定期タイマー（App.tsx）から呼ばれる自動保存。
  // 武装前・上書き対象が無い・前回保存から中身が変わっていない場合は何もしない
  autoSaveTick: async () => {
    const { autoSaveArmed, rawCsvText, rawFileHandle, rawFileIsBundle, loadedFileLabel, lines, vlines, rects, trendLines, channels, arrows, brushes, texts, closedTrades, candles, cursor, lastSavedBundleText } = get();
    if (!autoSaveArmed || rawCsvText === null || rawFileHandle === null || !rawFileIsBundle) return;
    const cursorTime = candles[cursor]?.time;
    const bundle = buildVtdBundle(rawCsvText, { lines, vlines, rects, trendLines, channels, arrows, brushes, texts, closedTrades, cursorTime });
    if (bundle === lastSavedBundleText) return; // 前回保存時から変化なし
    try {
      await writeToHandle(rawFileHandle, bundle);
      set({ lastSavedBundleText: bundle, lastSavedAt: Date.now(), loadingMsg: `✓ ${loadedFileLabel} に自動保存しました` });
      setTimeout(() => {
        if (get().loadingMsg.startsWith('✓')) set({ loadingMsg: '' });
      }, 4000);
    } catch (e) {
      // 自動保存の失敗はエラーバナーで気付ける程度に留め、armedは維持する（次回のtickで再試行）
      set({ error: `自動保存に失敗しました: ${String(e)}` });
    }
  },

  setTimeframe: async (sec: TimeframeSec, preloadedCandles?: Candle[]) => {
    const {
      isLoaded, isLoading, timeframeSec, candles, cursor, chartLayout, preMultiLayout,
      quad3Timeframes, quad3MainSlot, quad4Timeframes, quad4MainSlot, mainRevealedUntil,
      finestSourceCandles, finestSourceCursor,
    } = get();
    if (!isLoaded || isLoading || sec === timeframeSec) return;
    // 1画面表示中はpreMultiLayoutが指す方（直前に表示していたマルチ画面レイアウト）を更新する
    const activeQuad = (chartLayout === '1' ? preMultiLayout : chartLayout) === '3' ? '3' : '4';

    // 「今」の時刻はmainRevealedUntil（前回の切替からずっと据え置きの、実際にカーソルを
    // 動かした時点の値）を最優先する。時間足の切替を何度繰り返しても「今」がズレて
    // 進んだり戻ったりしないようにするため（例: 1H→1D→1Hと切り替えても何も変わらない）
    const boundary = mainRevealedUntil ?? (candles[cursor] !== undefined ? candles[cursor].time + timeframeSec : undefined);

    const applyNewCandles = (newCandles: Candle[]) => {
      let newCursor = 0;
      let candlesToUse = newCandles;
      if (boundary !== undefined && newCandles.length > 0) {
        const bi = findBucketIndexContaining(newCandles, boundary);
        if (bi >= 0) {
          const bucketStart = newCandles[bi].time;
          const bucketEnd = bucketStart + sec;
          if (bucketEnd <= boundary) {
            // 新しい時間足で見てもこのバケットは既に確定済み。そのまま使う
            newCursor = bi;
          } else {
            // まだ確定していない（形成中の）バケット。旧メインの確定済み足（0..cursor）
            // からこのバケット範囲だけを自前で再集計した部分足に差し替える——切替直後は
            // 「今」の瞬間をそのまま見せたいので、確定済みの1つ前のバケットまで戻したく
            // ない（実際に「1Hが1/8 10:00の時に1Dへ切り替えると1/8 07:00の形成中足では
            // なく1/7に戻ってしまう」という指摘を受けて、確定バケットへ丸めるのをやめた）
            // 直前のメイン（candles/cursor）ではなくfinestSourceCandlesを使うこと。
            // 前回切替でメインが粗い時間足（1D等）になっていた場合、candlesがその
            // 粗いデータのままだと他の細かい時間足（4H等）の部分集計に必要な粒度が
            // 無く、本来出せるはずの形成中足が出せなくなる
            const partial = buildPartialCandle(finestSourceCandles, finestSourceCursor, bucketStart, bucketEnd);
            if (partial) {
              candlesToUse = newCandles.slice();
              candlesToUse[bi] = partial;
              newCursor = bi;
            } else {
              // 部分集計できる元データが無い（新旧の時間足が噛み合わない等）場合のみ、
              // 従来通り直前の確定済みバケットへフォールバックする
              newCursor = Math.max(0, bi - 1);
            }
          }
        }
      }

      // メインが表示されている枠（3画面/4画面どちらか、現在アクティブな方のmainSlot）の
      // 時間軸も、メイン切替に追従させる
      if (activeQuad === '3') {
        const next = quad3Timeframes.slice();
        next[quad3MainSlot] = sec;
        saveQuad(QUAD3_STORAGE_KEY, next, quad3MainSlot);
        set({
          candles: candlesToUse, timeframeSec: sec, cursor: newCursor, mainRevealedUntil: boundary ?? null,
          quad3Timeframes: next,
          isLoading: false, loadingMsg: '', isPlaying: false,
        });
      } else {
        const next = quad4Timeframes.slice();
        next[quad4MainSlot] = sec;
        saveQuad(QUAD4_STORAGE_KEY, next, quad4MainSlot);
        set({
          candles: candlesToUse, timeframeSec: sec, cursor: newCursor, mainRevealedUntil: boundary ?? null,
          quad4Timeframes: next,
          isLoading: false, loadingMsg: '', isPlaying: false,
        });
      }
    };

    // 4画面でパネルを昇格させる時、その枠（非メインのCandleChartインスタンス）が既に
    // 自前でこの時間軸を集計済みなら、そのままもらってDuckDBへの再クエリを省略する
    // （panelは既に表示していたデータなので、切替のたびに待たされる無駄が無くなる）
    if (preloadedCandles && preloadedCandles.length > 0) {
      applyNewCandles(preloadedCandles);
      return;
    }

    set({ isLoading: true, loadingMsg: '集計中...', isPlaying: false });
    try {
      const db = await initDuckDB();
      const newCandles = await queryCandles(db, sec);
      applyNewCandles(newCandles);
    } catch (e) {
      set({ error: String(e), isLoading: false, loadingMsg: '' });
    }
  },

  advance: (steps = 1) => {
    const { cursor, candles, timeframeSec, positions, pendingOrders, closedTrades, balance, nextId } = get();
    if (cursor < candles.length - 1) {
      const newCursor = Math.min(cursor + Math.max(1, steps), candles.length - 1);
      const result = processOrderRange(candles, cursor, newCursor, positions, pendingOrders, closedTrades, balance, nextId);
      set({
        cursor: newCursor,
        // 実際にカーソルを動かしたので「今」を新しい足に合わせ直す（切替直後だけ
        // 据え置く形成中バケットの特例はここでリセットされる）
        mainRevealedUntil: candles[newCursor].time + timeframeSec,
        mainDisplayTime: candles[newCursor].time,
        finestSourceCandles: candles, finestSourceCursor: newCursor,
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

  // カーソルを1つ戻す（表示のみ。約定済みの注文・決済は取り消さない）。
  // 「最新足に固定」は解除しない（固定中なら戻った足が右寄せ位置に来て、1コマ進めても固定が続く）
  stepBack: () => {
    const { cursor, candles, timeframeSec } = get();
    if (cursor <= 0) {
      set({ isPlaying: false });
      return false;
    }
    const newCursor = cursor - 1;
    set({
      cursor: newCursor, isPlaying: false,
      mainRevealedUntil: candles[newCursor].time + timeframeSec,
      mainDisplayTime: candles[newCursor].time,
      finestSourceCandles: candles, finestSourceCursor: newCursor,
    });
    return true;
  },

  jumpToTime: (targetSec: number, opts) => {
    const { candles, cursor: oldCursor, timeframeSec, positions, pendingOrders, closedTrades, balance, nextId } = get();
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

    // 通常の「日付移動」は過去日付へジャンプしても cursor を戻さない（表示位置を動かす
    // だけ）。cursor はリプレイの進行位置＝データの開示境界そのものなので、ここを巻き戻すと
    // 「6/1へジャンプしたら7/1まで見えていた足が6/1以降ごと隠れて、6/1が最新足になる」
    // という直感に反する挙動になる。未来日付へのジャンプは従来どおり cursor を進め、
    // 通過した範囲の注文約定・TP/SL判定も行う（バックテストとして時間を進める意味がある）
    // 「巻き戻し」（opts.rewind）は逆に cursor をそのまま idx へ合わせ、指定日付を新しい
    // 最新足にする。stepBack同様、約定済みの注文・決済は取り消さない（表示位置＝開示境界
    // だけを戻す）
    // 垂直線チップ移動と同じ「縮尺維持で中心移動」を使う
    const newCursor = opts?.rewind ? idx : Math.max(idx, oldCursor);
    set(s => ({
      cursor: newCursor, isPlaying: false, centerTarget: targetSec, centerSignal: s.centerSignal + 1,
      followLatest: false,
      mainRevealedUntil: candles[newCursor].time + timeframeSec,
      mainDisplayTime: candles[newCursor].time,
      finestSourceCandles: candles, finestSourceCursor: newCursor,
      ...(result?.changed ? {
        positions: result.positions, pendingOrders: result.pendingOrders,
        closedTrades: result.closedTrades, balance: result.balance, nextId: result.nextId,
      } : {}),
    }));
  },

  fitToScreen: () => set(s => ({ fitSignal: s.fitSignal + 1, followLatest: false })),
  scrollToLatest: () => set(s => ({ scrollToLatestSignal: s.scrollToLatestSignal + 1, followLatest: true })),
  setFollowLatest: (v: boolean) => set(s => s.followLatest === v ? {} : { followLatest: v }),
  centerOnTime: (time: number) => set(s => ({ centerTarget: time, centerSignal: s.centerSignal + 1, followLatest: false })),

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
  clearDraft: () => set({ draftPrice: null, draftTP: null, draftSL: null, pickTarget: null }),

  togglePickTarget: (t: 'price' | 'tp' | 'sl') => {
    set(s => ({
      pickTarget: s.pickTarget === t ? null : t,
      isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, isJumpSync: false,
    }));
  },
  pickPrice: (price: number) => {
    const { pickTarget } = get();
    if (pickTarget === 'price') set({ draftPrice: price, pickTarget: null });
    else if (pickTarget === 'tp') set({ draftTP: price, pickTarget: null });
    else if (pickTarget === 'sl') set({ draftSL: price, pickTarget: null });
  },

  toggleJumpSync: () => set(s => ({
    isJumpSync: !s.isJumpSync,
    isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null,
  })),
  // 足をクリックした瞬間に呼ばれる。1回使ったらツールは自動的にOFFへ戻す（連続描画のような
  // 「置き続ける」概念が無いため、他の描画ツールと違いcontinuousDrawingの対象外）
  jumpSyncTo: (sourceId: string, time: number) => set(s => ({
    isJumpSync: false, jumpSyncSourceId: sourceId, jumpSyncTarget: time, jumpSyncSignal: s.jumpSyncSignal + 1,
  })),

  attachRrImage: ({ kind, id }, image) => set(s => kind === 'order'
    ? { pendingOrders: s.pendingOrders.map(o => o.id === id ? { ...o, rrImage: image } : o) }
    : {
        positions: s.positions.map(p => p.id === id ? { ...p, rrImage: image } : p),
        closedTrades: s.closedTrades.map(t => t.id === id ? { ...t, rrImage: image } : t),
      }),

  submitOrder: (side: Side, rrImage?: string) => {
    const { orderType, lots, lotMode, riskPercent, draftPrice, draftTP, draftSL, candles, cursor, positions, nextId, pendingOrders, nextOrderId, balance } = get();
    const c = candles[cursor];
    if (!c) return false;
    const tp = draftTP ?? undefined;
    const sl = draftSL ?? undefined;
    const entryPrice = orderType === 'market' ? c.close : draftPrice;

    // TP/SLは建値に対してBUY/SELLで上下が決まっている（あり得ない指定を弾く）。
    // BUY: TPは建値より上・SLは建値より下 / SELL: TPは建値より下・SLは建値より上。
    // リスク%モードのロット逆算がSLの絶対距離だけを見て符号を問わないため、ここで
    // 弾かないと「SLが建値より上のBUY」のような矛盾した注文がロット計算を素通りしてしまう
    if (entryPrice !== null) {
      if (tp !== undefined) {
        const tpValid = side === 'BUY' ? tp > entryPrice : tp < entryPrice;
        if (!tpValid) {
          set({ error: `${side} の TP は建値(${entryPrice})より${side === 'BUY' ? '上' : '下'}の価格を指定してください` });
          return false;
        }
      }
      if (sl !== undefined) {
        const slValid = side === 'BUY' ? sl < entryPrice : sl > entryPrice;
        if (!slValid) {
          set({ error: `${side} の SL は建値(${entryPrice})より${side === 'BUY' ? '下' : '上'}の価格を指定してください` });
          return false;
        }
      }
    }

    // リスク%モード: 残高 × risk% ÷ |エントリー価格 - SL| からロット数を逆算する
    let useLots = lots;
    if (lotMode === 'risk') {
      if (sl === undefined || entryPrice === null) {
        set({ error: 'リスク%指定には SL の設定が必要です' });
        return false;
      }
      const stopDistance = Math.abs(entryPrice - sl);
      if (stopDistance === 0) {
        set({ error: 'SL がエントリー価格と同じです' });
        return false;
      }
      useLots = Math.round((balance * (riskPercent / 100)) / stopDistance);
      if (useLots <= 0) {
        set({ error: '計算されたロット数が0以下です' });
        return false;
      }
    }

    // 今回の価格・TP・SLがエントリー価格から何%離れていたかを記録し、次回パネルを開いた時
    // （＋注文種別/方向を切り替えた時）の仮入力に使う。成行/指値/逆指値×BUY/SELLの組み合わせ
    // ごとに別々に覚える
    const priceRatio = orderType !== 'market' && draftPrice !== null ? (draftPrice - c.close) / c.close : null;
    const tpRatio = tp !== undefined && entryPrice !== null ? (tp - entryPrice) / entryPrice : null;
    const slRatio = sl !== undefined && entryPrice !== null ? (sl - entryPrice) / entryPrice : null;
    const ratioKey = `${orderType}:${side}`;
    const lastOrderRatiosByKey = { ...get().lastOrderRatiosByKey, [ratioKey]: { priceRatio, tpRatio, slRatio } };

    if (orderType === 'market') {
      // 証拠金チェック（簡易: 1証拠金 = lots × price × 0.04 ≒ 4%）
      const margin = useLots * c.close * 0.04;
      if (balance < margin) {
        set({ error: '残高が不足しています' });
        return false;
      }
      set({
        positions: [...positions, { id: nextId, side, openPrice: c.close, lots: useLots, openTime: c.time, tp, sl, rrImage }],
        nextId: nextId + 1,
        draftTP: null, draftSL: null,
        lastOrderRatiosByKey, error: null,
      });
      return true;
    } else {
      if (draftPrice === null) return false;

      // 指値・逆指値は現在値との上下関係が決まっている（実際の注文として成立する条件）
      // STOP-BUY: 現在値より上 / STOP-SELL: 現在値より下 / LIMIT-BUY: 現在値より下 / LIMIT-SELL: 現在値より上
      const mustBeAbove = orderType === 'stop' ? side === 'BUY' : side === 'SELL';
      const isAbove = draftPrice > c.close;
      if (isAbove !== mustBeAbove) {
        const typeLabel = orderType === 'stop' ? '逆指値' : '指値';
        set({ error: `${side} ${typeLabel} は現在値(${c.close})より${mustBeAbove ? '上' : '下'}の価格を指定してください` });
        return false;
      }

      set({
        pendingOrders: [...pendingOrders, { id: nextOrderId, side, type: orderType, price: draftPrice, lots: useLots, tp, sl, rrImage }],
        nextOrderId: nextOrderId + 1,
        lastOrderRatiosByKey,
        draftPrice: null, draftTP: null, draftSL: null, error: null,
      });
      return true;
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
        tp: pos.tp, sl: pos.sl, rrImage: pos.rrImage,
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
        tp: pos.tp, sl: pos.sl, rrImage: pos.rrImage,
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
    pushDrawHistory(get, set);
    // 丸めない（表示側で toFixed するだけにし、線の位置は連続値で持つ）
    const { lines, nextLineId, lineDraft, continuousDrawing } = get();
    set({
      lines: [...lines, { id: nextLineId, price, ...lineDraft }],
      nextLineId: nextLineId + 1,
      // 連続描画中はツールをOFFにせず、続けて次を置ける状態を保つ
      isDrawingLine: continuousDrawing,
    });
    // 配置直後はそのまま編集モードに入れる（selectLine経由でパレットモードの自動ONも揃う）。
    // 連続描画中でも呼ぶ——isDrawingLineはcontinuousDrawing側で維持しているので選択に
    // 入れても連続配置は妨げない。呼ばないと置いた直後の図形自身をパレットから直せない
    // （テキストで同じ理由の不具合を実際に踏んだため、全図形で足並みを揃えた）
    get().selectLine({ kind: 'h', id: nextLineId });
  },
  updateLine: (id: number, patch: Partial<Omit<DrawnLine, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ lines: s.lines.map(l => l.id === id ? { ...l, ...patch } : l) }));
  },
  removeLine: (id: number) => {
    pushDrawHistory(get, set);
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
    pushDrawHistory(get, set);
    set({ lines: [...lines, { ...src, id: nextLineId, price: newPrice }], nextLineId: nextLineId + 1 });
  },
  toggleDrawLine: () => set(s => {
    const next = !s.isDrawingLine;
    return { isDrawingLine: next, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  // 水平線・垂直線は同じlineDraftを共有する（addLine/addVLineとも参照している通り）
  setLineDraft: patch => { set(s => ({ lineDraft: { ...s.lineDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addVLine: (time: number) => {
    pushDrawHistory(get, set);
    const { vlines, nextVLineId, lineDraft, continuousDrawing } = get();
    set({
      vlines: [...vlines, { id: nextVLineId, time, ...lineDraft }],
      nextVLineId: nextVLineId + 1,
      isDrawingVLine: continuousDrawing,
    });
    get().selectLine({ kind: 'v', id: nextVLineId });
  },
  updateVLine: (id: number, patch: Partial<Omit<DrawnVLine, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ vlines: s.vlines.map(v => v.id === id ? { ...v, ...patch } : v) }));
  },
  removeVLine: (id: number) => {
    pushDrawHistory(get, set);
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
    pushDrawHistory(get, set);
    set({ vlines: [...vlines, { ...src, id: nextVLineId, time: newTime }], nextVLineId: nextVLineId + 1 });
  },
  toggleDrawVLine: () => set(s => {
    const next = !s.isDrawingVLine;
    return { isDrawingVLine: next, isDrawingLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  toggleMeasure: () => set(s => ({ isMeasuring: !s.isMeasuring, isDrawingLine: false, isDrawingVLine: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false })),
  toggleHLinePriceLabel: () => set(s => {
    const next = !s.showHLinePriceLabel;
    saveLineLabels(next, s.showVLineDateLabel);
    return { showHLinePriceLabel: next };
  }),
  toggleVLineDateLabel: () => set(s => {
    const next = !s.showVLineDateLabel;
    saveLineLabels(s.showHLinePriceLabel, next);
    return { showVLineDateLabel: next };
  }),

  addRect: (time1: number, price1: number, time2: number, price2: number) => {
    pushDrawHistory(get, set);
    const { rects, nextRectId, rectDraft, continuousDrawing } = get();
    set({
      rects: [...rects, { id: nextRectId, time1, price1, time2, price2, ...rectDraft }],
      nextRectId: nextRectId + 1,
      isDrawingRect: continuousDrawing,
    });
    get().selectLine({ kind: 'rect', id: nextRectId });
  },
  updateRect: (id: number, patch: Partial<Omit<DrawnRect, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ rects: s.rects.map(r => r.id === id ? { ...r, ...patch } : r) }));
  },
  removeRect: (id: number) => {
    pushDrawHistory(get, set);
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
    pushDrawHistory(get, set);
    set({ rects: [...rects, { ...src, id: nextRectId, time1, price1, time2, price2 }], nextRectId: nextRectId + 1 });
  },
  toggleDrawRect: () => set(s => {
    const next = !s.isDrawingRect;
    return { isDrawingRect: next, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setRectDraft: patch => { set(s => ({ rectDraft: { ...s.rectDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addTrendLine: (time1: number, price1: number, time2: number, price2: number) => {
    pushDrawHistory(get, set);
    const { trendLines, nextTrendLineId, trendLineDraft, continuousDrawing } = get();
    set({
      trendLines: [...trendLines, { id: nextTrendLineId, time1, price1, time2, price2, ...trendLineDraft }],
      nextTrendLineId: nextTrendLineId + 1,
      isDrawingTrendLine: continuousDrawing,
    });
    get().selectLine({ kind: 'trend', id: nextTrendLineId });
  },
  updateTrendLine: (id: number, patch: Partial<Omit<DrawnTrendLine, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ trendLines: s.trendLines.map(tl => tl.id === id ? { ...tl, ...patch } : tl) }));
  },
  removeTrendLine: (id: number) => {
    pushDrawHistory(get, set);
    set(s => {
      const wasSelected = s.selected?.kind === 'trend' && s.selected.id === id;
      return {
        trendLines: s.trendLines.filter(tl => tl.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateTrendLine: (id: number, time1: number, price1: number, time2: number, price2: number) => {
    const { trendLines, nextTrendLineId } = get();
    const src = trendLines.find(tl => tl.id === id);
    if (!src) return;
    pushDrawHistory(get, set);
    set({ trendLines: [...trendLines, { ...src, id: nextTrendLineId, time1, price1, time2, price2 }], nextTrendLineId: nextTrendLineId + 1 });
  },
  toggleDrawTrendLine: () => set(s => {
    const next = !s.isDrawingTrendLine;
    return { isDrawingTrendLine: next, isDrawingChannel: false, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setTrendLineDraft: patch => { set(s => ({ trendLineDraft: { ...s.trendLineDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addChannel: (time1: number, price1: number, time2: number, price2: number, offset: number) => {
    pushDrawHistory(get, set);
    const { channels, nextChannelId, channelDraft, continuousDrawing } = get();
    set({
      channels: [...channels, { id: nextChannelId, time1, price1, time2, price2, offset, ...channelDraft }],
      nextChannelId: nextChannelId + 1,
      isDrawingChannel: continuousDrawing,
    });
    get().selectLine({ kind: 'channel', id: nextChannelId });
  },
  updateChannel: (id: number, patch: Partial<Omit<DrawnChannel, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ channels: s.channels.map(ch => ch.id === id ? { ...ch, ...patch } : ch) }));
  },
  removeChannel: (id: number) => {
    pushDrawHistory(get, set);
    set(s => {
      const wasSelected = s.selected?.kind === 'channel' && s.selected.id === id;
      return {
        channels: s.channels.filter(ch => ch.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateChannel: (id: number, time1: number, price1: number, time2: number, price2: number) => {
    const { channels, nextChannelId } = get();
    const src = channels.find(ch => ch.id === id);
    if (!src) return;
    pushDrawHistory(get, set);
    set({ channels: [...channels, { ...src, id: nextChannelId, time1, price1, time2, price2 }], nextChannelId: nextChannelId + 1 });
  },
  toggleDrawChannel: () => set(s => {
    const next = !s.isDrawingChannel;
    return { isDrawingChannel: next, isDrawingTrendLine: false, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingArrow: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setChannelDraft: patch => { set(s => ({ channelDraft: { ...s.channelDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addArrow: (time1: number, price1: number, time2: number, price2: number) => {
    pushDrawHistory(get, set);
    const { arrows, nextArrowId, arrowDraft, continuousDrawing } = get();
    set({
      arrows: [...arrows, { id: nextArrowId, time1, price1, time2, price2, ...arrowDraft }],
      nextArrowId: nextArrowId + 1,
      isDrawingArrow: continuousDrawing,
    });
    get().selectLine({ kind: 'arrow', id: nextArrowId });
  },
  updateArrow: (id: number, patch: Partial<Omit<DrawnArrow, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ arrows: s.arrows.map(a => a.id === id ? { ...a, ...patch } : a) }));
  },
  removeArrow: (id: number) => {
    pushDrawHistory(get, set);
    set(s => {
      const wasSelected = s.selected?.kind === 'arrow' && s.selected.id === id;
      return {
        arrows: s.arrows.filter(a => a.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateArrow: (id: number, time1: number, price1: number, time2: number, price2: number) => {
    const { arrows, nextArrowId } = get();
    const src = arrows.find(a => a.id === id);
    if (!src) return;
    pushDrawHistory(get, set);
    set({ arrows: [...arrows, { ...src, id: nextArrowId, time1, price1, time2, price2 }], nextArrowId: nextArrowId + 1 });
  },
  toggleDrawArrow: () => set(s => {
    const next = !s.isDrawingArrow;
    return { isDrawingArrow: next, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingBrush: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setArrowDraft: patch => { set(s => ({ arrowDraft: { ...s.arrowDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addBrush: (points: { time: number; price: number }[], opts?: { shape?: 'triangle' | 'circle' }) => {
    pushDrawHistory(get, set);
    const { brushes, nextBrushId, brushDraft, continuousDrawing } = get();
    set({
      brushes: [...brushes, { id: nextBrushId, points, ...brushDraft, ...(opts?.shape ? { shape: opts.shape } : {}) }],
      nextBrushId: nextBrushId + 1,
      isDrawingBrush: continuousDrawing,
    });
    get().selectLine({ kind: 'brush', id: nextBrushId });
  },
  updateBrush: (id: number, patch: Partial<Omit<DrawnBrush, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ brushes: s.brushes.map(b => b.id === id ? { ...b, ...patch } : b) }));
  },
  removeBrush: (id: number) => {
    pushDrawHistory(get, set);
    set(s => {
      const wasSelected = s.selected?.kind === 'brush' && s.selected.id === id;
      return {
        brushes: s.brushes.filter(b => b.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateBrush: (id: number, points: { time: number; price: number }[]) => {
    const { brushes, nextBrushId } = get();
    const src = brushes.find(b => b.id === id);
    if (!src) return;
    pushDrawHistory(get, set);
    set({ brushes: [...brushes, { ...src, id: nextBrushId, points }], nextBrushId: nextBrushId + 1 });
  },
  toggleDrawBrush: () => set(s => {
    const next = !s.isDrawingBrush;
    return { isDrawingBrush: next, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingText: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setBrushDraft: patch => { set(s => ({ brushDraft: { ...s.brushDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },

  addText: (time: number, price: number, text: string) => {
    pushDrawHistory(get, set);
    const { texts, nextTextId, textDraft, continuousDrawing } = get();
    set({
      texts: [...texts, { id: nextTextId, time, price, text, ...textDraft }],
      nextTextId: nextTextId + 1,
      isDrawingText: continuousDrawing,
    });
    // 他の図形と違い、テキストは配置直後がそのまま入力中の編集セッションになる。
    // 連続描画中でも選択状態には必ず入れる（selectLineを呼ぶ）——そうしないと
    // 入力中のこのテキスト自身の色をパレットから変えられなくなる（armedKind経由の
    // 「次に置く分」のtextDraftを触るだけになり、今書いている実体には反映されない）。
    // isDrawingTextはcontinuousDrawing側で維持しているので、この後編集を終えれば
    // （blur等）そのまま次のテキストを続けて置ける
    get().selectLine({ kind: 'text', id: nextTextId });
  },
  updateText: (id: number, patch: Partial<Omit<DrawnText, 'id'>>) => {
    pushDrawHistory(get, set);
    set(s => ({ texts: s.texts.map(t => t.id === id ? { ...t, ...patch } : t) }));
  },
  removeText: (id: number) => {
    pushDrawHistory(get, set);
    set(s => {
      const wasSelected = s.selected?.kind === 'text' && s.selected.id === id;
      return {
        texts: s.texts.filter(t => t.id !== id),
        selected: wasSelected ? null : s.selected,
        paletteMode: wasSelected ? false : s.paletteMode,
      };
    });
  },
  duplicateText: (id: number, time: number, price: number) => {
    const { texts, nextTextId } = get();
    const src = texts.find(t => t.id === id);
    if (!src) return;
    pushDrawHistory(get, set);
    set({ texts: [...texts, { ...src, id: nextTextId, time, price }], nextTextId: nextTextId + 1 });
  },
  toggleDrawText: () => set(s => {
    const next = !s.isDrawingText;
    return { isDrawingText: next, isDrawingLine: false, isDrawingVLine: false, isMeasuring: false, isDrawingRect: false, isDrawingTrendLine: false, isDrawingChannel: false, isDrawingArrow: false, isDrawingBrush: false, pickTarget: null, isJumpSync: false, ...armPatch(next) };
  }),
  setTextDraft: patch => { set(s => ({ textDraft: { ...s.textDraft, ...patch } })); saveDrawDrafts(pickDrawDrafts(get())); },
  // 描画ツールの切替（toggleDrawLine等）では触らない独立したロック的トグル
  toggleContinuousDrawing: () => set(s => ({ continuousDrawing: !s.continuousDrawing })),

  setTradeMemo: (id, memo) => set(s => ({
    closedTrades: s.closedTrades.map(t => t.id === id ? { ...t, memo: memo === '' ? undefined : memo } : t),
  })),

  restrictKindToTimeframe: (kind, timeframeSec) => {
    pushDrawHistory(get, set);
    // 指定timeframeSecだけ残し、他の個別指定可能な時間足（1H/4H/1D/1W/MN）は全部隠す
    const hiddenTimeframes = HIDABLE_TIMEFRAMES.filter(t => t !== timeframeHideKey(timeframeSec));
    const restrict = <T extends { hiddenTimeframes?: TimeframeSec[] }>(arr: T[]): T[] =>
      arr.map(o => isHiddenTimeframesVisibleAt(o, timeframeSec) ? { ...o, hiddenTimeframes } : o);
    set(s => {
      switch (kind) {
        case 'h': return { lines: restrict(s.lines) };
        case 'v': return { vlines: restrict(s.vlines) };
        case 'rect': return { rects: restrict(s.rects) };
        case 'trend': return { trendLines: restrict(s.trendLines) };
        case 'channel': return { channels: restrict(s.channels) };
        case 'arrow': return { arrows: restrict(s.arrows) };
        case 'brush': return { brushes: restrict(s.brushes) };
        case 'text': return { texts: restrict(s.texts) };
      }
    });
  },

  showKindOnAllTimeframes: (kind, timeframeSec) => {
    pushDrawHistory(get, set);
    // restrictKindToTimeframeの逆: このtimeframeSecで表示中かつどこかの時間足で非表示に
    // 制限されているものだけを対象にhiddenTimeframesを空にする（制限の無い図形には触らない）
    const restore = <T extends { hiddenTimeframes?: TimeframeSec[] }>(arr: T[]): T[] =>
      arr.map(o => isHiddenTimeframesVisibleAt(o, timeframeSec) && (o.hiddenTimeframes?.length ?? 0) > 0 ? { ...o, hiddenTimeframes: [] } : o);
    set(s => {
      switch (kind) {
        case 'h': return { lines: restore(s.lines) };
        case 'v': return { vlines: restore(s.vlines) };
        case 'rect': return { rects: restore(s.rects) };
        case 'trend': return { trendLines: restore(s.trendLines) };
        case 'channel': return { channels: restore(s.channels) };
        case 'arrow': return { arrows: restore(s.arrows) };
        case 'brush': return { brushes: restore(s.brushes) };
        case 'text': return { texts: restore(s.texts) };
      }
    });
  },

  undo: () => {
    const { drawHistory } = get();
    if (drawHistory.length === 0) return;
    const prev = drawHistory[drawHistory.length - 1];
    set({
      lines: prev.lines, vlines: prev.vlines, rects: prev.rects, trendLines: prev.trendLines, channels: prev.channels, arrows: prev.arrows, brushes: prev.brushes, texts: prev.texts,
      nextLineId: prev.nextLineId, nextVLineId: prev.nextVLineId, nextRectId: prev.nextRectId, nextTrendLineId: prev.nextTrendLineId, nextChannelId: prev.nextChannelId, nextArrowId: prev.nextArrowId, nextBrushId: prev.nextBrushId, nextTextId: prev.nextTextId,
      drawHistory: drawHistory.slice(0, -1),
      selected: null, paletteMode: false,
    });
  },
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
  setPaletteStyle: patch => {
    set(s => ({ paletteStyle: { ...s.paletteStyle, ...patch } }));
    // 編集モード（選択中）のままパレットの設定を変えた時も、選び直さなくてもすぐ反映する
    const { paletteMode, selected, paletteStyle } = get();
    if (!paletteMode || !selected) return;
    applyPaletteStyleTo(get, selected);
    // 次に同じ種類の図形を新規配置する時のデフォルト値（各種Draft）にも引き継ぐ。
    // 連続描画中に「1つ前でパレットから変えた色が次の配置に反映されない」という指摘を
    // 受けて追加した（単発配置でも実害は無い——次に別の図形を選択した時はそちらの現在値が
    // syncPaletteStyleFromで優先して取り込まれるため、Draftを更新しても上書きされない）
    if (selected.kind === 'h' || selected.kind === 'v') get().setLineDraft({ color: paletteStyle.color, dash: paletteStyle.dash, width: paletteStyle.width });
    else if (selected.kind === 'rect') get().setRectDraft({ color: paletteStyle.color, dash: paletteStyle.dash, width: paletteStyle.width });
    else if (selected.kind === 'trend') get().setTrendLineDraft({ color: paletteStyle.color, dash: paletteStyle.dash, width: paletteStyle.width });
    else if (selected.kind === 'channel') get().setChannelDraft({ color: paletteStyle.color, dash: paletteStyle.dash, width: paletteStyle.width });
    else if (selected.kind === 'arrow') get().setArrowDraft({ color: paletteStyle.color, dash: paletteStyle.dash, width: paletteStyle.width });
    else if (selected.kind === 'brush') get().setBrushDraft({ color: paletteStyle.color, width: paletteStyle.width });
    else get().setTextDraft({ color: paletteStyle.color, fontSize: paletteStyle.fontSize, border: paletteStyle.border });
  },
  toggleEMA: () => set(s => ({ showEMA: !s.showEMA })),
  toggleSMA: () => set(s => ({ showSMA: !s.showSMA })),
  toggleBB: () => set(s => ({ showBB: !s.showBB })),
  toggleCloud: () => set(s => ({ showCloud: !s.showCloud })),
  toggleOverlaysHidden: () => set(s => ({ overlaysHidden: !s.overlaysHidden })),
  toggleWeekLines: () => set(s => ({ showWeekLines: !s.showWeekLines })),
  toggleSessions: () => set(s => ({ showSessions: !s.showSessions })),
  // 「チャート全表示」: 一時的なプレビューではなく、読み込んだデータの最後まで実際に
  // カーソルを進める（通過した範囲の注文約定・TP/SL判定も行う。advanceを1本ずつ
  // 呼ぶ代わりにprocessOrderRangeへ一括で渡すことで、本数が多くても一瞬で終わる）
  advanceToEnd: () => {
    const { cursor, candles, timeframeSec, positions, pendingOrders, closedTrades, balance, nextId } = get();
    if (candles.length === 0) return;
    const lastIdx = candles.length - 1;
    if (cursor >= lastIdx) { set({ isPlaying: false }); return; }
    const result = processOrderRange(candles, cursor, lastIdx, positions, pendingOrders, closedTrades, balance, nextId);
    set({
      cursor: lastIdx,
      mainRevealedUntil: candles[lastIdx].time + timeframeSec,
      mainDisplayTime: candles[lastIdx].time,
      finestSourceCandles: candles, finestSourceCursor: lastIdx,
      isPlaying: false,
      ...(result.changed ? {
        positions: result.positions, pendingOrders: result.pendingOrders,
        closedTrades: result.closedTrades, balance: result.balance, nextId: result.nextId,
      } : {}),
    });
  },
  toggleHistoryPanel: () => set(s => ({ showHistoryPanel: !s.showHistoryPanel })),
  setMemoTradeId: id => set({ memoTradeId: id }),
  toggleTradeMarkersForTimeframe: (sec) => set(s => {
    const currentlyVisible = s.tradeMarkersVisible[sec] !== false; // 未登録＝表示がデフォルト
    return { tradeMarkersVisible: { ...s.tradeMarkersVisible, [sec]: !currentlyVisible } };
  }),
  openHistoryForTrade: (tradeId) => set({ showHistoryPanel: true, scrollToTradeId: tradeId }),
  setScrollToTradeId: (tradeId) => set({ scrollToTradeId: tradeId }),
  setOrderPanelOpen: (open) => set({ orderPanelOpen: open }),
  setChartMargins: (right: number, bottom: number) => set({ chartRightMargin: right, chartBottomMargin: bottom }),
  setChartLayout: (layout: ChartLayout) => {
    const before = get();
    const currentActive = before.chartLayout === '1' ? before.preMultiLayout : before.chartLayout;
    const targetActive = layout === '1' ? before.preMultiLayout : layout;

    saveChartLayout(layout);
    set(layout === '1' ? { chartLayout: layout } : { chartLayout: layout, preMultiLayout: layout });

    // 3画面と4画面は完全に別管理（各々のメイン枠・時間軸を独立して記憶）なので、
    // 表示中のマルチ画面レイアウトが実際に切り替わる時だけ、切替先が最後に使っていた
    // メイン時間軸へ実データも切り替える（1画面⇔同じレイアウトの往復では何もしない）
    if (targetActive !== currentActive) {
      const { quad3Timeframes, quad3MainSlot, quad4Timeframes, quad4MainSlot } = get();
      const sec = targetActive === '3' ? quad3Timeframes[quad3MainSlot] : quad4Timeframes[quad4MainSlot];
      void get().setTimeframe(sec);
    }
  },

  // 3画面の枠配置パターンを切替（左1枠+右2枠 ⇔ 上1枠+下2枠）。quad3Timeframes/quad3MainSlotは
  // パターン間で共有しているため、切替は見た目の配置が変わるだけでメイン枠・時間軸は保たれる
  toggleQuad3Pattern: () => {
    const next = get().quad3Pattern === 'left' ? 'top' : 'left';
    saveQuad3Pattern(next);
    set({ quad3Pattern: next });
  },

  // 3画面/4画面のミニ枠（メインでない枠）の表示時間軸を変更。メイン枠が指定された場合は
  // 通常のメイン時間軸切替として扱う（setTimeframeに委譲、データ再取得を伴うため）。
  // どちらの画面数の状態を操作するかは呼び出し時点のchartLayoutで判定する
  // （非メイン枠のクリックはマルチ画面表示中にしか起きないため、常に'3'か'4'のはず）
  setQuadTimeframe: (slot: number, sec: TimeframeSec) => {
    const { chartLayout, quad3Timeframes, quad3MainSlot, quad4Timeframes, quad4MainSlot } = get();
    if (chartLayout === '3') {
      if (slot === quad3MainSlot) { void get().setTimeframe(sec); return; }
      const next = quad3Timeframes.slice();
      next[slot] = sec;
      saveQuad(QUAD3_STORAGE_KEY, next, quad3MainSlot);
      set({ quad3Timeframes: next });
    } else {
      if (slot === quad4MainSlot) { void get().setTimeframe(sec); return; }
      const next = quad4Timeframes.slice();
      next[slot] = sec;
      saveQuad(QUAD4_STORAGE_KEY, next, quad4MainSlot);
      set({ quad4Timeframes: next });
    }
  },

  // ミニ枠をクリックしてメイン（操作可能パネル）に昇格。枠の時間軸をそのままメインに引き継ぐ。
  // setQuadTimeframeと同じく、呼び出し時点のchartLayout（'3'か'4'のはず）で対象を判定する
  promoteSlotToMain: (slot: number, preloadedCandles?: Candle[]) => {
    const { chartLayout, quad3Timeframes, quad4Timeframes } = get();
    if (chartLayout === '3') {
      set({ quad3MainSlot: slot });
      saveQuad(QUAD3_STORAGE_KEY, quad3Timeframes, slot);
      void get().setTimeframe(quad3Timeframes[slot], preloadedCandles);
    } else {
      set({ quad4MainSlot: slot });
      saveQuad(QUAD4_STORAGE_KEY, quad4Timeframes, slot);
      void get().setTimeframe(quad4Timeframes[slot], preloadedCandles);
    }
  },

  // 4画面時、十字カーソルの同期表示用。実マウス操作しているパネル（sourceId）と時刻を共有し、
  // 他パネルはこの時刻に`setCrosshairPosition`で追従表示する
  setCrosshair: (sourceId: string | null, time: number | null) => set({ crosshairSourceId: sourceId, crosshairTime: time }),
  setActivePanelSlot: (slot: number) => set(s => s.activePanelSlot === slot ? {} : { activePanelSlot: slot }),
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
