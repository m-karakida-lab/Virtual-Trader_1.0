import type { LineDash } from '../../types';

// 四角形・トレンドライン・平行チャネル・垂直線等、canvas自前描画系の線種→setLineDash変換。
// sync関数がCandleChartのマウント時に即時呼び出しされるため、コンポーネント内のローカル
// constではなくモジュールレベルに置く（TDZ回避）
export const DASH_TO_CANVAS: Record<LineDash, number[]> = {
  solid: [], dashed: [7, 5], dotted: [1, 4],
};

// ロウソク足と重なった部分をdestination-outで透明に抜く関数（CandleChartのcutCandlesFromCanvas）
export type CutCandles = (ctx: CanvasRenderingContext2D, w: number) => void;

// オーバーレイcanvasの1フレーム分の下準備。実解像度をdevicePixelRatio倍で確保し
// （しないとRetina等で線がぼやけ、斜め線・曲線が階段状に見える）、setTransformで
// 描画側の座標系はCSSピクセルのまま（w,hがそのまま使える）にして全面クリアする
export function beginCanvasFrame(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) canvas.width = w * dpr;
  if (canvas.height !== h * dpr) canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
