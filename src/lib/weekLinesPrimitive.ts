// 週/日/月区切り線も、四角形の枠線（rectPrimitive.ts）と同じ理由でSeries Primitivesで描く。
// 従来はDOMオーバーレイ（z-index固定）だったため、四角形をローソク足の下に沈めても
// 区切り線は常にDOMの最前面に残り、四角形より上に来てしまっていた
import type { ISeriesPrimitive, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export class WeekLinesPrimitive implements ISeriesPrimitive<Time> {
  private _requestUpdate: (() => void) | null = null;
  // 描画対象のx座標（ピクセル）一覧。ホスト側（CandleChart）が算出して差し込む
  getXs: () => number[] = () => [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._requestUpdate = null;
  }

  requestUpdate(): void {
    this._requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews(): ISeriesPrimitivePaneView[] {
    return [{
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: (target: CanvasRenderingTarget2D) => {
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const xs = this.getXs();
            if (xs.length === 0) return;
            ctx.save();
            ctx.strokeStyle = '#4a4a4a';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            for (const x of xs) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, mediaSize.height);
              ctx.stroke();
            }
            ctx.restore();
          });
        },
      }),
    }];
  }
}
