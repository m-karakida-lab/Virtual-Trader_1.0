// 四角形描画の枠線を、DOMオーバーレイではなくlightweight-chartsのSeries Primitives API
// （chart本体のレンダリングパイプラインに描画を差し込む公式機構）で描く。
// DOMのz-indexだけではローソク足の「下・背景の上」という中間の重なり順を作れない
// （ローソク足・背景・グリッドは同じ1枚のcanvasにまとめて描画されているため、外側の
// DOM要素は重なり順が「そのcanvas全体より下（背景ごと隠れる）」か「上（今まで通り）」の
// 二択しかない）。zOrder:'bottom'のprimitiveは「背景の上・ローソク足はじめ他の全ての下」
// に描画される、という公式のAPIでのみこの中間の重なり順を実現できる
import type { ISeriesPrimitive, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { LineDash } from '../types';

const DASH_TO_CANVAS: Record<LineDash, number[]> = {
  solid: [], dashed: [7, 5], dotted: [1, 4],
};

export interface RectPrimitiveItem {
  x1: number; y1: number; x2: number; y2: number;
  color: string; dash: LineDash; width: number;
}

export class RectanglesPrimitive implements ISeriesPrimitive<Time> {
  private _requestUpdate: (() => void) | null = null;
  // 描画対象は毎フレームこの関数から取得する（pull方式）。ホストのCandleChart側が
  // 現在のrects/選択状態/ドラッグ中プレビューから計算した配列をここに差し込む
  getItems: () => RectPrimitiveItem[] = () => [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._requestUpdate = null;
  }

  // store変更（色変更・Undo・CSV再読込等）はchart自身のインタラクションを伴わないため、
  // 呼び出し側（CandleChart）が該当箇所で明示的にこれを呼んでchartに再描画を要求する必要がある
  requestUpdate(): void {
    this._requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews(): ISeriesPrimitivePaneView[] {
    return [{
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: (target: CanvasRenderingTarget2D) => {
          target.useMediaCoordinateSpace(({ context: ctx }) => {
            for (const it of this.getItems()) {
              ctx.save();
              ctx.strokeStyle = it.color;
              ctx.lineWidth = it.width;
              ctx.setLineDash(DASH_TO_CANVAS[it.dash]);
              const x = Math.min(it.x1, it.x2);
              const y = Math.min(it.y1, it.y2);
              ctx.strokeRect(x, y, Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
              ctx.restore();
            }
          });
        },
      }),
    }];
  }
}
