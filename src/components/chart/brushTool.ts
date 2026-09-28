import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import { recognizeShape } from '../../lib/shapeRecognition';
import type { ReadRef, TimeToX } from './refs';
import type { BrushCircleCorner, BrushVertex } from './hitTest';
import {
  CONSUMED, combineTools, createFrameThrottle, lockChartForDrag, unlockChartAfterDrag,
  type DragSession, type EditTool,
} from './drag';

type TimePrice = { time: number; price: number };

// 点は毎mousemoveで（1フレーム1点の間引きをせず）記録する。フレーム単位で間引くと速く動かした
// 時にこそ点が粗くなり、カクカクした多角形に見える。代わりにピクセル距離基準（BRUSH_MIN_PXより
// 動いた時だけ記録）で間引き、遅いドラッグでの無駄な点の肥大化を防ぐ。描き直しだけ1フレーム1回に間引く
const BRUSH_MIN_PX = 2;
// 円ブラシのリサイズで外周を作り直す時の分割数（図形認識の円生成と同じ）
const CIRCLE_RESIZE_STEPS = 64;

export interface BrushToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  // 三角形の頂点・円の角（選択中の図形認識ブラシのみ）と、フリーハンドの線の当たり判定
  findVertex: (x: number, y: number) => BrushVertex | null;
  findCircleCorner: (x: number, y: number) => BrushCircleCorner | null;
  findBody: (x: number, y: number) => number | null;
  // 描画モジュール（brushesOverlay）が読むドラッグ中/新規描画中の点列と、その描き直し
  setDragPreview: (p: { id: number; points: TimePrice[] } | null) => void;
  setNewDraft: (points: TimePrice[] | null) => void;
  sync: () => void;
  magnetSnap: (x: number, y: number) => { price: number; y: number } | null;
  pixelToContinuousTime: (x: number) => number | null;
  timeToX: TimeToX;
}

// ブラシのマウス操作: フリーハンドの新規描画（離した時に三角形/円らしければ綺麗な図形へスナップ）、
// 全体の平行移動、図形認識した三角形の頂点・円のバウンディングボックス角での再編集
export function createBrushTool(deps: BrushToolDeps) {
  const {
    chart, container, seriesRef, findVertex, findCircleCorner, findBody,
    setDragPreview, setNewDraft, sync, magnetSnap, pixelToContinuousTime, timeToX,
  } = deps;
  const brushes = () => useTraderStore.getState().brushes;
  const select = (id: number) => useTraderStore.getState().selectLine({ kind: 'brush', id });

  // ピクセル空間のバウンディングボックス（2点）から楕円の外周点列を生成し、time/priceへ変換する
  const regenerateCirclePointsFromPxBox = (x1: number, y1: number, x2: number, y2: number): TimePrice[] | null => {
    if (!seriesRef.current) return null;
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    if (rx <= 0 || ry <= 0) return null;
    const cx = minX + rx, cy = minY + ry;
    const out: TimePrice[] = [];
    for (let i = 0; i <= CIRCLE_RESIZE_STEPS; i++) {
      const a = (i / CIRCLE_RESIZE_STEPS) * Math.PI * 2;
      const px = cx + rx * Math.cos(a), py = cy + ry * Math.sin(a);
      const time = pixelToContinuousTime(px);
      const price = seriesRef.current.coordinateToPrice(py);
      if (time === null || price === null) return null;
      out.push({ time, price });
    }
    return out;
  };

  // フリーハンドはマグネットで吸着させない（吸着すると滑らかな線が描けなくなる）
  const startDraw = (x: number, y: number): DragSession | null => {
    if (!seriesRef.current) return null;
    const price = seriesRef.current.coordinateToPrice(y);
    const time = pixelToContinuousTime(x);
    if (price === null || time === null) return null;
    let points: TimePrice[] = [{ time, price }];
    // pointsと1対1で並走するピクセル座標版。図形認識は時間軸と価格軸でスケールが全く異なる
    // time/price空間では「見た目のバランス」を判定できないため、確定時にこちらで判定する
    let pxPoints = [{ x, y }];
    let lastPx = { x, y };
    const throttle = createFrameThrottle();
    lockChartForDrag(chart);
    setNewDraft(points);
    sync();
    return {
      move(mx, my) {
        if (!seriesRef.current) return;
        if (Math.hypot(mx - lastPx.x, my - lastPx.y) < BRUSH_MIN_PX) return;
        const p = seriesRef.current.coordinateToPrice(my);
        const t = pixelToContinuousTime(mx);
        if (p === null || t === null) return;
        points = [...points, { time: t, price: p }];
        pxPoints = [...pxPoints, { x: mx, y: my }];
        lastPx = { x: mx, y: my };
        setNewDraft(points);
        throttle(sync);
      },
      end() {
        unlockChartAfterDrag(chart);
        setNewDraft(null);
        if (points.length >= 2) {
          // 図形認識: 閉じた三角形/円っぽいストロークなら綺麗な図形にスナップする（判定はピクセル座標）
          const recognized = seriesRef.current ? recognizeShape(pxPoints) : null;
          const converted = recognized && seriesRef.current
            ? recognized.points.map(pt => ({
                time: pixelToContinuousTime(pt.x),
                price: seriesRef.current!.coordinateToPrice(pt.y),
              }))
            : null;
          const allValid = converted !== null && converted.every(p => p.time !== null && p.price !== null);
          if (recognized && allValid) {
            // 円もshape付き（平滑化なしの直線つなぎ）で描画する。平滑化は両端点を固定したまま処理する
            // ため、始点=終点の閉じた輪に通すと継ぎ目だけ角が残る。shapeを付けておくことで選択中に
            // 専用の編集ハンドル（三角形=各頂点、円=バウンディングボックスの角）も出せる
            useTraderStore.getState().addBrush(
              converted!.map(p => ({ time: p.time as number, price: p.price as number })),
              { shape: recognized.type },
            );
          } else {
            useTraderStore.getState().addBrush(points);
          }
        }
        sync(); // ドラフトのクリア
      },
    };
  };

  // 図形認識で作った三角形の頂点ドラッグ（points[3]は輪を閉じるための始点の複製なので、頂点0と一緒に動かす）
  const vertexTool: EditTool = {
    hoverCursor: (x, y) => (findVertex(x, y) !== null ? 'nwse-resize' : null),
    tryStartEdit: (x, y) => {
      const vertex = findVertex(x, y);
      if (vertex === null) return null;
      lockChartForDrag(chart);
      container.style.cursor = 'nwse-resize';
      select(vertex.brushId);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: TimePrice | null = null;
      const withVertex = (points: TimePrice[], pos: TimePrice) =>
        points.map((pt, i) => (i === vertex.vertexIndex || (vertex.vertexIndex === 0 && i === 3) ? pos : pt));
      return {
        move(mx, my) {
          if (!seriesRef.current) return;
          const snap = magnetSnap(mx, my);
          const time = pixelToContinuousTime(mx);
          if (snap === null || time === null) return;
          pending = { time, price: snap.price };
          throttle(() => {
            if (!active || pending === null) return;
            const b = brushes().find(bb => bb.id === vertex.brushId);
            if (!b) return;
            setDragPreview({ id: b.id, points: withVertex(b.points, pending) });
            sync();
          });
        },
        end() {
          if (pending !== null) {
            const b = brushes().find(bb => bb.id === vertex.brushId);
            if (b) useTraderStore.getState().updateBrush(vertex.brushId, { points: withVertex(b.points, pending) });
          }
          active = false;
          pending = null;
          setDragPreview(null);
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };

  // 図形認識で作った円のバウンディングボックス角のドラッグ。対角（固定側）をピクセル座標で控え、
  // ドラッグ中の角と合わせたボックスから楕円の点列を作り直す
  const circleCornerTool: EditTool = {
    hoverCursor: (x, y) => (findCircleCorner(x, y) !== null ? 'nwse-resize' : null),
    tryStartEdit: (x, y) => {
      const corner = findCircleCorner(x, y);
      if (corner === null) return null;
      if (!seriesRef.current) return CONSUMED;
      const src = brushes().find(b => b.id === corner.brushId);
      if (!src) return CONSUMED;
      const pxPts: { x: number; y: number }[] = [];
      for (const p of src.points) {
        const px = timeToX(p.time), py = seriesRef.current.priceToCoordinate(p.price);
        if (px !== null && py !== null) pxPts.push({ x: px, y: py });
      }
      if (pxPts.length === 0) return CONSUMED;
      const minX = Math.min(...pxPts.map(p => p.x)), maxX = Math.max(...pxPts.map(p => p.x));
      const minY = Math.min(...pxPts.map(p => p.y)), maxY = Math.max(...pxPts.map(p => p.y));
      const fixed = {
        x: corner.corner === 'tl' || corner.corner === 'bl' ? maxX : minX,
        y: corner.corner === 'tl' || corner.corner === 'tr' ? maxY : minY,
      };
      lockChartForDrag(chart);
      container.style.cursor = 'nwse-resize';
      select(corner.brushId);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: { x: number; y: number } | null = null;
      return {
        move(mx, my) {
          pending = { x: mx, y: my };
          throttle(() => {
            if (!active || pending === null) return;
            const newPoints = regenerateCirclePointsFromPxBox(fixed.x, fixed.y, pending.x, pending.y);
            if (!newPoints) return;
            setDragPreview({ id: corner.brushId, points: newPoints });
            sync();
          });
        },
        end() {
          if (pending !== null) {
            const newPoints = regenerateCirclePointsFromPxBox(fixed.x, fixed.y, pending.x, pending.y);
            if (newPoints) useTraderStore.getState().updateBrush(corner.brushId, { points: newPoints });
          }
          active = false;
          pending = null;
          setDragPreview(null);
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };

  // 全体の平行移動。フリーハンドは幅を保つような不変条件が無いので、足のインデックスではなく
  // 素の時間差分で全ての点をまとめてずらす
  const moveTool: EditTool = {
    hoverCursor: (x, y) => (findBody(x, y) !== null ? 'move' : null),
    tryStartEdit: (x, y) => {
      const id = findBody(x, y);
      if (id === null) return null;
      if (!seriesRef.current) return CONSUMED;
      const src = brushes().find(b => b.id === id);
      const startTime = pixelToContinuousTime(x);
      const startPrice = seriesRef.current.coordinateToPrice(y);
      if (!src || startTime === null || startPrice === null) return CONSUMED;
      const startPoints = src.points;
      lockChartForDrag(chart);
      container.style.cursor = 'move';
      select(id);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: { dt: number; dp: number } | null = null;
      const shifted = (d: { dt: number; dp: number }) => startPoints.map(pt => ({ time: pt.time + d.dt, price: pt.price + d.dp }));
      return {
        move(mx, my) {
          if (!seriesRef.current) return;
          const t = pixelToContinuousTime(mx);
          const p = seriesRef.current.coordinateToPrice(my);
          if (t === null || p === null) return;
          pending = { dt: t - startTime, dp: p - startPrice };
          throttle(() => {
            if (!active || pending === null) return;
            setDragPreview({ id, points: shifted(pending) });
            sync();
          });
        },
        end() {
          if (pending !== null) useTraderStore.getState().updateBrush(id, { points: shifted(pending) });
          active = false;
          pending = null;
          setDragPreview(null);
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };

  // 三角形の頂点・円の角（選択中のみ）→線全体の順に試す
  const editTool = combineTools([vertexTool, circleCornerTool, moveTool]);

  return { startDraw, editTool };
}
