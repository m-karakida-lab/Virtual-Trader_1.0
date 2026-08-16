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

// 表示時間軸（秒）
export const TIMEFRAMES = [
  { sec: 900,   label: '15m' },
  { sec: 3600,  label: '1H' },
  { sec: 14400, label: '4H' },
  { sec: 86400, label: '1D' },
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

// 水平線・垂直線を問わず「選択中の1本」を表す
export type LineSelection = { kind: 'h' | 'v'; id: number };
