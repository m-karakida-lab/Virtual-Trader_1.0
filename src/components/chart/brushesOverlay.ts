import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { DEFAULT_BRUSH_SMOOTHING } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { beginCanvasFrame } from './canvas';

type TimePrice = { time: number; price: number };

const BRUSH_HANDLE_R = 5;

// マウスの生の点列をそのまま繋ぐと手ブレがそのまま線に出るため、描画直前（記録データ
// 自体はいじらない）にボックスフィルタをpassesパスかける。通過回数はブラシごとに
// パレットで調整できる（DrawnBrush.smoothing、未設定時はDEFAULT_BRUSH_SMOOTHING）。
// 両端は動かさない（ストロークの始点・終点がズレると選択リング等とズレて見える）
const smoothPixelPoints = (pts: { x: number; y: number }[], passes: number): { x: number; y: number }[] => {
  if (pts.length < 3 || passes <= 0) return pts;
  let cur = pts;
  for (let pass = 0; pass < passes; pass++) {
    const next: { x: number; y: number }[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push({
        x: (cur[i - 1].x + cur[i].x + cur[i + 1].x) / 3,
        y: (cur[i - 1].y + cur[i].y + cur[i + 1].y) / 3,
      });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
};

export interface BrushesOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  // ドラッグ中（平行移動・図形認識ブラシの頂点/角）の既存ブラシの点列
  getDragPreview: Getter<{ id: number; points: TimePrice[] } | null>;
  // 新規描画中（まだstoreに存在しない）の軌跡。ドラッグしている間だけ生きる
  getNewDraft: Getter<TimePrice[] | null>;
}

// ブラシ（フリーハンド、TradingViewの「ブラシ」相当）。トレンドラインと同じcanvas方式だが、
// ドラッグの軌跡をそのまま点列として繋いで描く。線種の概念は無い
export function createSyncBrushes(deps: BrushesOverlayDeps): () => void {
  const { chartRef, seriesRef, canvasRef, timeToX, getVisibleDrawings, getDragPreview, getNewDraft } = deps;

  const drawBrushStroke = (
    ctx: CanvasRenderingContext2D,
    points: TimePrice[],
    color: string, width: number, selected: boolean, shape?: 'triangle' | 'circle', smoothing: number = DEFAULT_BRUSH_SMOOTHING,
  ) => {
    if (!seriesRef.current || points.length < 2) return;
    const pixelPoints: { x: number; y: number }[] = [];
    for (const p of points) {
      const x = timeToX(p.time);
      const y = seriesRef.current.priceToCoordinate(p.price);
      if (x === null || y === null) continue;
      pixelPoints.push({ x, y });
    }
    if (pixelPoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (shape) {
      // 図形認識（三角形/円）でスナップされた点列: 手ブレ補正や曲線化はせず、
      // 点同士をそのまま直線で結ぶ（角を丸めると「綺麗な図形」に見えなくなる。
      // 円は点数が多いため直線つなぎでも見た目には滑らか）
      ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
      for (let i = 1; i < pixelPoints.length; i++) ctx.lineTo(pixelPoints[i].x, pixelPoints[i].y);
    } else {
      const smoothed = smoothPixelPoints(pixelPoints, smoothing);
      ctx.moveTo(smoothed[0].x, smoothed[0].y);
      // 各点をコントロールポイントに、次の点との中点までを2次ベジェで繋ぐ定番の
      // 手書き線平滑化（直線つなぎだと点の間隔が粗い時にカクカクした多角形に見える）
      for (let i = 1; i < smoothed.length - 1; i++) {
        const midX = (smoothed[i].x + smoothed[i + 1].x) / 2;
        const midY = (smoothed[i].y + smoothed[i + 1].y) / 2;
        ctx.quadraticCurveTo(smoothed[i].x, smoothed[i].y, midX, midY);
      }
      const last = smoothed[smoothed.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = '#42a5f5';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      // 図形認識で作った三角形/円は専用の編集ハンドルを出す（掴んで再編集できる）。
      // 普通のフリーハンドは始点・終点に選択の目印（ハンドルではない）を出すだけ
      if (shape === 'triangle') {
        for (const p of [pixelPoints[0], pixelPoints[1], pixelPoints[2]]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, BRUSH_HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (shape === 'circle') {
        const xs = pixelPoints.map(p => p.x), ys = pixelPoints.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        for (const p of [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: minX, y: maxY }, { x: maxX, y: maxY }]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, BRUSH_HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
        for (const p of [pixelPoints[0], pixelPoints[pixelPoints.length - 1]]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  };

  return () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx } = frame;

    const { selected } = useTraderStore.getState();
    const selectedBrushId = selected?.kind === 'brush' ? selected.id : null;
    const dragPreview = getDragPreview();
    const newDraft = getNewDraft();

    for (const b of getVisibleDrawings().brushes) {
      const live = dragPreview && dragPreview.id === b.id ? dragPreview.points : b.points;
      drawBrushStroke(ctx, live, b.color, b.width, b.id === selectedBrushId, b.shape, b.smoothing ?? DEFAULT_BRUSH_SMOOTHING);
    }

    if (newDraft) {
      const { brushDraft } = useTraderStore.getState();
      drawBrushStroke(ctx, newDraft, brushDraft.color, brushDraft.width, false, undefined, brushDraft.smoothing);
    }
  };
}
