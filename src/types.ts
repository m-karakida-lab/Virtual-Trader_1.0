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
  { sec: 300,       label: '5m' },
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

// 赤→黄→ティール→青→紫→ピンク→グレー→白の順（指定された表示順。
// オレンジは黄と似て見づらいという指摘を受けピンクに差し替え、紫の右へ移動した）
export const LINE_COLORS = ['#ef5350', '#ffca28', '#26a69a', '#42a5f5', '#ab47bc', '#ec407a', '#787b86', '#e0e0e0'];

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

// ── ブラシ（フリーハンド） ───────────────────────────────────────────────

// TradingViewの「ブラシ」相当。ドラッグの軌跡をそのまま点列として持つ
// （2点だけの図形と違い、なめらかさに応じて点数が増減する）。線種の概念は無く
// （フリーハンドの線に破線/点線は馴染まない）、色と太さだけ持つ
export interface DrawnBrush {
  id: number;
  points: { time: number; price: number }[];
  color: string;
  width: LineWidth;
  // 図形認識（三角形/円）で生成された場合true。直線＋平滑化なしで描画する
  // （円も、手ブレ補正の平滑化パイプラインに通すと閉じた輪の継ぎ目だけ丸められず
  // 角が残るため、点数の多い直線つなぎで代用する）
  straight?: boolean;
}

// ── テキストボックス ─────────────────────────────────────────────────────

// 文字サイズは4段階固定（px値そのものを持つ。S/M/L/XL相当）
export type TextFontSize = 14 | 18 | 24 | 32;
export const TEXT_FONT_SIZES: TextFontSize[] = [14, 18, 24, 32];

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

// 水平線・垂直線・四角形・トレンドライン・ブラシ・テキストを問わず「選択中の1つ」を表す
export type LineSelection = { kind: 'h' | 'v' | 'rect' | 'trend' | 'brush' | 'text'; id: number };
