export interface Candle {
  time: number; // Unix timestamp (seconds, UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Side = 'BUY' | 'SELL';
export type OrderType = 'market' | 'limit' | 'stop';

export interface Position {
  id: number;
  side: Side;
  openPrice: number;
  lots: number;
  openTime: number;
  tp?: number; // テイクプロフィット価格
  sl?: number; // ストップロス価格
}

// 指値・逆指値の未約定注文（価格がローソク足の範囲に入ったら Position に変換される）
export interface PendingOrder {
  id: number;
  side: Side;
  type: 'limit' | 'stop';
  price: number;
  lots: number;
  tp?: number;
  sl?: number;
}

// 決済済みトレードの履歴（チャート上のエントリー・決済マーカー表示用）
export interface ClosedTrade {
  id: number;
  side: Side;
  openPrice: number;
  closePrice: number;
  openTime: number;
  closeTime: number;
  lots: number;
  pnl: number;
}

// 表示時間軸（秒）。月足は暦月ごとに日数が違うため厳密な秒数ではなく、
// 平均月長（365.2425日/12）を「おおよその足の長さ」として使う（区切り線の日/月境界計算やDB集計は
// カレンダー基準の date_trunc を別途使うため、この値のズレが実データに影響することはない）
export const WEEK_SEC = 604800;
export const MONTH_SEC = 2629746;

export const TIMEFRAMES = [
  { sec: 900,       label: '15m' },
  { sec: 3600,      label: '1H' },
  { sec: 14400,     label: '4H' },
  { sec: 86400,     label: '1D' },
  { sec: WEEK_SEC,  label: '1W' },
  { sec: MONTH_SEC, label: 'MN' },
] as const;

export type TimeframeSec = typeof TIMEFRAMES[number]['sec'];

// ── 水平線 ───────────────────────────────────────────────────────────────

export type LineDash = 'solid' | 'dashed' | 'dotted';
export type LineWidth = 1 | 2 | 3 | 4;

// ── マグネット（描画時の価格スナップ） ─────────────────────────────────────
// off: 吸着しない / weak: 足のOHLCに近づいた時だけ吸着 / strong: 常に最寄りのOHLCへ吸着
export type MagnetMode = 'off' | 'weak' | 'strong';

export interface DrawnLine {
  id: number;
  price: number;
  color: string;
  dash: LineDash;
  width: LineWidth;
}

// ── 垂直線 ───────────────────────────────────────────────────────────────

export interface DrawnVLine {
  id: number;
  time: number; // Unix秒（UTC）
  color: string;
  dash: LineDash;
  width: LineWidth;
}

export const LINE_COLORS = ['#787b86', '#ef5350', '#26a69a', '#42a5f5', '#ffa726', '#ab47bc', '#ffca28', '#e0e0e0'];

// ── 四角形 ───────────────────────────────────────────────────────────────

export interface DrawnRect {
  id: number;
  time1: number; price1: number; // 始点（Unix秒・価格）
  time2: number; price2: number; // 終点
  color: string;
  dash: LineDash;
  width: LineWidth;
}

// ── トレンドライン ───────────────────────────────────────────────────────

// 四角形と同じ2点（始点・終点）だが、対角の矩形ではなく2点を結ぶ斜めの線分として描画する
export interface DrawnTrendLine {
  id: number;
  time1: number; price1: number; // 始点
  time2: number; price2: number; // 終点
  color: string;
  dash: LineDash;
  width: LineWidth;
}

// ── テキストボックス ─────────────────────────────────────────────────────

// 文字サイズは4段階固定（px値そのものを持つ。S/M/L/XL相当）
export type TextFontSize = 11 | 14 | 18 | 24;
export const TEXT_FONT_SIZES: TextFontSize[] = [11, 14, 18, 24];

// テキストボックスの枠線。線種（水平線・垂直線・四角形と共通のLineDash）に加えて
// 「枠無し」を選べる（水平線・垂直線・四角形にはこの選択肢は無い）
export type TextBorderStyle = LineDash | 'none';

export interface DrawnText {
  id: number;
  time: number; // Unix秒（UTC）。テキストの左上のアンカー位置
  price: number;
  text: string;
  color: string;
  fontSize: TextFontSize;
  border: TextBorderStyle;
}

// 水平線・垂直線・四角形・トレンドライン・テキストを問わず「選択中の1つ」を表す
export type LineSelection = { kind: 'h' | 'v' | 'rect' | 'trend' | 'text'; id: number };
