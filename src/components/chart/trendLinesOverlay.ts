import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LineDash } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { DASH_TO_CANVAS, beginCanvasFrame } from './canvas';

// 2点図形（トレンドライン・平行チャネル・矢印）の端点ハンドルの半径
export const TREND_HANDLE_R = 5;

// 2点を結ぶ線分。選択中は端点ハンドルも同じcanvas上に円で描く（平行チャネルも共用）
export const drawTrendLineShape = (
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  color: string, dash: LineDash, width: number, selected: boolean,
) => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(DASH_TO_CANVAS[dash]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (selected) {
    ctx.setLineDash([]);
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

// 平行チャネルのオフセット線（2本目）を選択した時の編集マーク。オフセット線自体は
// 基準線からの平行移動（幅調整）でしか編集できないため、水平線と同じ「中点に1個だけ」の四角ハンドル
export const drawMidpointHandle = (ctx: CanvasRenderingContext2D, cx: number, cy: number) => {
  ctx.save();
  ctx.fillStyle = '#42a5f5';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  const s = TREND_HANDLE_R * 2;
  ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
  ctx.restore();
};

export type TwoPointDrag = { id: number; time1: number; price1: number; time2: number; price2: number };
export type PxSegment = { x1: number; y1: number; x2: number; y2: number };

export interface TrendLinesOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  // ドラッグ中（端点リサイズ・平行移動）の既存トレンドライン
  getDragPreview: Getter<TwoPointDrag | null>;
  // 新規描画中（まだstoreに存在しない）の線分。ドラッグの間だけ生きるのでピクセル座標のみ
  getNewDraft: Getter<PxSegment | null>;
}

// トレンドライン（2点を結ぶ斜めの線分）。DOMのborderでは表現できないため専用canvasに描く
export function createSyncTrendLines(deps: TrendLinesOverlayDeps): () => void {
  const { chartRef, seriesRef, canvasRef, timeToX, getVisibleDrawings, getDragPreview, getNewDraft } = deps;
  return () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w, h } = frame;
    const series = seriesRef.current;

    const { selected, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const { trendLines: visibleTrendLines } = getVisibleDrawings();
    const selectedTrendId = selected?.kind === 'trend' ? selected.id : null;
    const dragPreview = getDragPreview();
    const newDraft = getNewDraft();

    // 日付軸欄（chartBottomMargin分の帯）に線が食い込まないよう、その手前でクリップする。
    // 斜め線は四角形のようにy座標をクランプすると角度が変わってしまうためclipで制限する
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h - bottomMargin);
    ctx.clip();

    for (const tl of visibleTrendLines) {
      const live = dragPreview && dragPreview.id === tl.id ? dragPreview : tl;
      const x1 = timeToX(live.time1);
      const x2 = timeToX(live.time2);
      const y1 = series.priceToCoordinate(live.price1);
      const y2 = series.priceToCoordinate(live.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      drawTrendLineShape(ctx, x1, y1, x2, y2, tl.color, tl.dash, tl.width, tl.id === selectedTrendId);
    }

    if (newDraft) {
      const { trendLineDraft } = useTraderStore.getState();
      const { x1, y1, x2, y2 } = newDraft;
      drawTrendLineShape(ctx, x1, y1, x2, y2, trendLineDraft.color, trendLineDraft.dash, trendLineDraft.width, false);
    }
    ctx.restore();
  };
}
