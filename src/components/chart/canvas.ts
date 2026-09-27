import type { LineDash } from '../../types';

// 四角形・トレンドライン・平行チャネル・垂直線等、canvas自前描画系の線種→setLineDash変換。
// sync関数がCandleChartのマウント時に即時呼び出しされるため、コンポーネント内のローカル
// constではなくモジュールレベルに置く（TDZ回避——ローカルにして踏んだ経緯があるため要注意）
export const DASH_TO_CANVAS: Record<LineDash, number[]> = {
  solid: [], dashed: [7, 5], dotted: [1, 4],
};

// ロウソク足と重なった部分をdestination-outで透明に抜く関数（CandleChartのcutCandlesFromCanvas）
export type CutCandles = (ctx: CanvasRenderingContext2D, w: number) => void;
