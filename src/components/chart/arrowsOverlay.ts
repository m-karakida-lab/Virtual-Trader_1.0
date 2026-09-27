import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LineDash } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { DASH_TO_CANVAS, beginCanvasFrame } from './canvas';
import { TREND_HANDLE_R, type PxSegment, type TwoPointDrag } from './trendLinesOverlay';

const ARROW_HEAD_LEN = 12; // 矢印ヘッドの長さの基準値（線の太さに応じて少し太らせる）
const ARROW_HEAD_ANGLE = Math.PI / 7; // 矢印ヘッドの開き角（左右それぞれ約25.7度）

const drawArrowShape = (
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  color: string, dash: LineDash, width: number, selected: boolean,
) => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(DASH_TO_CANVAS[dash]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // 矢先（終点=x2,y2）に、線の向きを軸にした二等辺三角形を塗りつぶして矢印ヘッドにする
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = ARROW_HEAD_LEN + width * 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - ARROW_HEAD_ANGLE), y2 - headLen * Math.sin(angle - ARROW_HEAD_ANGLE));
  ctx.lineTo(x2 - headLen * Math.cos(angle + ARROW_HEAD_ANGLE), y2 - headLen * Math.sin(angle + ARROW_HEAD_ANGLE));
  ctx.closePath();
  ctx.fill();

  if (selected) {
    ctx.fillStyle = '#42a5f5';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
      ctx.beginPath();
      ctx.arc(ex, ey, TREND_HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
};

export interface ArrowsOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  getDragPreview: Getter<TwoPointDrag | null>;
  getNewDraft: Getter<PxSegment | null>;
}

// 矢印（特定の足を指し示す）。トレンドラインと同じ2点構造・操作性だが、
// 終点（矢先）に三角形の矢印ヘッドを描き足す点だけが違う
export function createSyncArrows(deps: ArrowsOverlayDeps): () => void {
  const { chartRef, seriesRef, canvasRef, timeToX, getVisibleDrawings, getDragPreview, getNewDraft } = deps;
  return () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx } = frame;
    const series = seriesRef.current;

    const { selected } = useTraderStore.getState();
    const selectedArrowId = selected?.kind === 'arrow' ? selected.id : null;
    const dragPreview = getDragPreview();
    const newDraft = getNewDraft();

    for (const ar of getVisibleDrawings().arrows) {
      const live = dragPreview && dragPreview.id === ar.id ? dragPreview : ar;
      const x1 = timeToX(live.time1);
      const x2 = timeToX(live.time2);
      const y1 = series.priceToCoordinate(live.price1);
      const y2 = series.priceToCoordinate(live.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      drawArrowShape(ctx, x1, y1, x2, y2, ar.color, ar.dash, ar.width, ar.id === selectedArrowId);
    }

    if (newDraft) {
      const { arrowDraft } = useTraderStore.getState();
      const { x1, y1, x2, y2 } = newDraft;
      drawArrowShape(ctx, x1, y1, x2, y2, arrowDraft.color, arrowDraft.dash, arrowDraft.width, false);
    }
  };
}
