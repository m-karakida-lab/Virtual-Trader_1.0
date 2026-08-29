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

export const LINE_COLORS = ['#787b86', '#ef5350', '#26a69a', '#42a5f5', '#ffa726', '#ab47bc'];

// ── 四角形 ───────────────────────────────────────────────────────────────

export interface DrawnRect {
  id: number;
  time1: number; price1: number; // 始点（Unix秒・価格）
  time2: number; price2: number; // 終点
  color: string;
  width: LineWidth;
}

export const RECT_COLORS = ['#2962ff', '#ef5350', '#ffca28', '#26a69a']; // 青・赤・黄・緑

// 水平線・垂直線・四角形を問わず「選択中の1つ」を表す
export type LineSelection = { kind: 'h' | 'v' | 'rect'; id: number };
