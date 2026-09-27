import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LineDash } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { DASH_TO_CANVAS, beginCanvasFrame, type CutCandles } from './canvas';

const RECT_HANDLE_SIZE = 10;

export type RectPx = { x1: number; y1: number; x2: number; y2: number };

export interface RectsOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  handleOverlayRef: ReadRef<HTMLDivElement | null>;
  // 選択中の四角形の4隅+4辺ハンドル（常に1個の四角形分のみ、初回syncで8個生成）
  handleElsRef: ReadRef<HTMLDivElement[]>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  cutCandlesFromCanvas: CutCandles;
  // ドラッグ中（コーナー/辺リサイズ・移動）の既存四角形のピクセル座標
  getDragPreview: Getter<(RectPx & { id: number }) | null>;
  // 新規描画中（まだstoreに存在しない）の四角形のピクセル座標
  getNewDraft: Getter<RectPx | null>;
}

// 四角形。枠線は専用canvasに自前描画し、destination-outでロウソク足と重なった部分を
// 透明に抜く（グリッド線より上・ロウソク足より下に見える。Series Primitivesはグリッド線・
// 標準価格ラインが対象外で「グリッド線より下」を実現できないため使わない）。
// DOMは選択中のリサイズハンドルのみ
export function createRectsOverlay(deps: RectsOverlayDeps) {
  const {
    chartRef, seriesRef, canvasRef, handleOverlayRef, handleElsRef,
    timeToX, getVisibleDrawings, cutCandlesFromCanvas, getDragPreview, getNewDraft,
  } = deps;

  // 4隅+4辺の中点にハンドルを配置する（0-3=4隅、4-7=上/下/左/右の中点）。
  // syncRects（store確定後）だけでなく、コーナー/辺ドラッグ中のrAFプレビューからも
  // 同じフレームで呼ぶことで、ドラッグ中に本体だけ動いてハンドルが取り残されるのを防ぐ
  const positionRectHandles = (x1: number, x2: number, y1: number, y2: number) => {
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    const points: [number, number][] = [
      [x1, y1], [x1, y2], [x2, y1], [x2, y2],
      [midX, Math.min(y1, y2)], [midX, Math.max(y1, y2)],
      [Math.min(x1, x2), midY], [Math.max(x1, x2), midY],
    ];
    points.forEach(([cx, cy], i) => {
      const h = handleElsRef.current[i];
      if (!h) return;
      h.style.display = 'block';
      h.style.left = `${cx - RECT_HANDLE_SIZE / 2}px`;
      h.style.top = `${cy - RECT_HANDLE_SIZE / 2}px`;
    });
  };

  const sync = () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current || !handleOverlayRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w, h } = frame;
    const series = seriesRef.current;

    const { selected, rectDraft, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const { rects: visibleRects } = getVisibleDrawings();
    const handleOverlay = handleOverlayRef.current;
    const selectedRectId = selected?.kind === 'rect' ? selected.id : null;
    const dragPreview = getDragPreview();
    const newDraft = getNewDraft();
    // 日付軸欄（chartBottomMargin分の帯）に食い込まないよう下端をクランプする（枠線・
    // 選択ハンドルとも同じクランプ後の値を使うこと——片方だけ変えると位置がズレる）
    const clampBottom = (y: number) => Math.min(y, h - bottomMargin);

    // 縦線（左右）と横線（上下）を別々に描く
    const drawVerticalSides = (x1: number, y1: number, x2: number, y2: number, color: string, dash: LineDash, width: number) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(DASH_TO_CANVAS[dash]);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x1, y2);
      ctx.moveTo(x2, y1); ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    };
    const drawHorizontalSides = (x1: number, y1: number, x2: number, y2: number, color: string, dash: LineDash, width: number) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(DASH_TO_CANVAS[dash]);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y1);
      ctx.moveTo(x1, y2); ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    };

    const boxes: { x1: number; y1: number; x2: number; y2: number; color: string; dash: LineDash; width: number }[] = [];
    for (const r of visibleRects) {
      const live = dragPreview && dragPreview.id === r.id ? dragPreview : null;
      const x1 = live ? live.x1 : timeToX(r.time1);
      const x2 = live ? live.x2 : timeToX(r.time2);
      const y1 = live ? live.y1 : series.priceToCoordinate(r.price1);
      const y2 = live ? live.y2 : series.priceToCoordinate(r.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      boxes.push({ x1, y1: clampBottom(y1), x2, y2: clampBottom(y2), color: r.color, dash: r.dash, width: r.width });
    }
    if (newDraft) {
      boxes.push({
        ...newDraft,
        y1: clampBottom(newDraft.y1),
        y2: clampBottom(newDraft.y2),
        color: rectDraft.color, dash: rectDraft.dash, width: rectDraft.width,
      });
    }

    // 縦線・横線ともdestination-out（下）より前に描き、ロウソク足を優先させる
    for (const b of boxes) drawVerticalSides(b.x1, b.y1, b.x2, b.y2, b.color, b.dash, b.width);
    for (const b of boxes) drawHorizontalSides(b.x1, b.y1, b.x2, b.y2, b.color, b.dash, b.width);

    if (boxes.length > 0) cutCandlesFromCanvas(ctx, w);

    // ハンドルは選択中の四角形1つぶんだけ使い回す（毎回作り直さない）
    const handles = handleElsRef.current;
    while (handles.length < 8) {
      const hEl = document.createElement('div');
      hEl.style.position = 'absolute';
      hEl.style.width = `${RECT_HANDLE_SIZE}px`;
      hEl.style.height = `${RECT_HANDLE_SIZE}px`;
      hEl.style.backgroundColor = '#42a5f5';
      hEl.style.border = '1px solid #fff';
      hEl.style.borderRadius = '2px';
      hEl.style.pointerEvents = 'none';
      hEl.style.display = 'none';
      handleOverlay.appendChild(hEl);
      handles.push(hEl);
    }

    let hasSelected = false;
    // 非表示中の四角形はvisibleRectsに含まれないので、選択中でもリサイズハンドルは出ない
    const selectedRect = selectedRectId !== null ? visibleRects.find(r => r.id === selectedRectId) : undefined;
    if (selectedRect) {
      const live = dragPreview && dragPreview.id === selectedRect.id ? dragPreview : null;
      const x1 = live ? live.x1 : timeToX(selectedRect.time1);
      const x2 = live ? live.x2 : timeToX(selectedRect.time2);
      const y1 = live ? live.y1 : series.priceToCoordinate(selectedRect.price1);
      const y2 = live ? live.y2 : series.priceToCoordinate(selectedRect.price2);
      if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) {
        hasSelected = true;
        positionRectHandles(x1, x2, clampBottom(y1), clampBottom(y2));
      }
    }
    if (!hasSelected) {
      handles.forEach(hEl => { hEl.style.display = 'none'; });
    }
  };

  return { sync, positionRectHandles };
}
