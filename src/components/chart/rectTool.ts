import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle, DrawnRect } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef, TimeToX } from './refs';
import type { RectPx } from './rectsOverlay';
import type { RectCorner, RectEdge } from './hitTest';
import { candleIndexAt } from './candleIndex';
import {
  CONSUMED, combineTools, createFrameThrottle, lockChartForDrag, unlockChartAfterDrag,
  type DragSession, type EditTool,
} from './drag';

export interface RectToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  // 角・辺の中点ハンドル（選択中の四角形のみ）と枠線の当たり判定
  findCorner: (x: number, y: number) => RectCorner | null;
  findEdge: (x: number, y: number) => RectEdge | null;
  findBorder: (x: number, y: number) => number | null;
  // 描画モジュール（rectsOverlay）が読むドラッグ中/新規描画中のピクセル座標と、その描き直し
  setDragPreview: (p: (RectPx & { id: number }) | null) => void;
  setNewDraft: (d: RectPx | null) => void;
  sync: () => void;
  // ドラッグ中は本体とハンドルを同じフレームで動かす（本体だけ動いてハンドルが取り残されないように）
  positionRectHandles: (x1: number, x2: number, y1: number, y2: number) => void;
  magnetSnap: (x: number, y: number) => { price: number; y: number } | null;
  pixelToTime: (x: number) => number | null;
  timeToX: TimeToX;
}

// 四角形のマウス操作: 新規描画（ドラッグ）、角のリサイズ、辺の中点での一方向リサイズ、
// 枠線をつかんでの平行移動。プレビューはピクセル座標で描き、mouseupでstoreへコミットする
export function createRectTool(deps: RectToolDeps) {
  const {
    chart, container, seriesRef, displayCandlesRef, findCorner, findEdge, findBorder,
    setDragPreview, setNewDraft, sync, positionRectHandles, magnetSnap, pixelToTime, timeToX,
  } = deps;
  const rects = () => useTraderStore.getState().rects;
  const select = (id: number) => useTraderStore.getState().selectLine({ kind: 'rect', id });

  // time/priceの2点をピクセル座標にしてプレビューとハンドルを描き直す（どれか変換できなければ何もしない）
  const previewAt = (id: number, time1: number, price1: number, time2: number, price2: number) => {
    if (!seriesRef.current) return;
    const x1 = timeToX(time1);
    const x2 = timeToX(time2);
    const y1 = seriesRef.current.priceToCoordinate(price1);
    const y2 = seriesRef.current.priceToCoordinate(price2);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;
    setDragPreview({ id, x1, y1, x2, y2 });
    sync();
    positionRectHandles(x1, x2, y1, y2);
  };

  const startDraw = (x: number, y: number): DragSession | null => {
    if (!seriesRef.current) return null;
    const snap = magnetSnap(x, y);
    if (snap === null) return null;
    const start = { x, y: snap.y, price: snap.price };
    let pendingEnd = { x, y: snap.y, price: snap.price };
    lockChartForDrag(chart);
    setNewDraft({ x1: x, y1: snap.y, x2: x, y2: snap.y });
    sync();
    return {
      move(mx, my) {
        const s = magnetSnap(mx, my);
        if (s === null) return;
        pendingEnd = { x: mx, y: s.y, price: s.price };
        setNewDraft({ x1: start.x, y1: start.y, x2: mx, y2: s.y });
        sync();
      },
      end() {
        unlockChartAfterDrag(chart);
        setNewDraft(null);
        sync();
        if (!seriesRef.current) return;
        const t1 = pixelToTime(start.x);
        const t2 = pixelToTime(pendingEnd.x);
        const p1 = start.price;
        const p2 = pendingEnd.price;
        if (t1 !== null && t2 !== null && (t1 !== t2 || p1 !== p2)) useTraderStore.getState().addRect(t1, p1, t2, p2);
      },
    };
  };

  // 角のリサイズ: 掴んだ角のtime/priceだけ動かし、対角は固定する
  const cornerTool: EditTool = {
    hoverCursor: (x, y) => (findCorner(x, y) !== null ? 'nwse-resize' : null),
    tryStartEdit: (x, y) => {
      const corner = findCorner(x, y);
      if (corner === null) return null;
      lockChartForDrag(chart);
      container.style.cursor = 'nwse-resize';
      select(corner.rectId);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: { time: number; price: number } | null = null;
      return {
        move(mx, my) {
          if (!seriesRef.current) return;
          const price = magnetSnap(mx, my)?.price ?? null;
          const time = pixelToTime(mx);
          if (price === null || time === null) return;
          pending = { time, price };
          throttle(() => {
            if (!active || pending === null) return;
            const r = rects().find(rr => rr.id === corner.rectId);
            if (!r) return;
            const otherTime = corner.timeField === 'time1' ? r.time2 : r.time1;
            const otherPrice = corner.priceField === 'price1' ? r.price2 : r.price1;
            previewAt(r.id, pending.time, pending.price, otherTime, otherPrice);
          });
        },
        end() {
          if (pending !== null) {
            useTraderStore.getState().updateRect(corner.rectId, { [corner.timeField]: pending.time, [corner.priceField]: pending.price });
          }
          active = false;
          pending = null;
          setDragPreview(null);
          sync();
          unlockChartAfterDrag(chart);
        },
      };
    },
  };

  // 辺の中点: 1フィールド（time1/time2/price1/price2のうち掴んだ時にその位置だった方）だけ動かす
  const edgeTool: EditTool = {
    hoverCursor: (x, y) => {
      const edge = findEdge(x, y);
      if (edge === null) return null;
      return edge.field === 'time1' || edge.field === 'time2' ? 'ew-resize' : 'ns-resize';
    },
    tryStartEdit: (x, y) => {
      const edge = findEdge(x, y);
      if (edge === null) return null;
      const isTimeField = edge.field === 'time1' || edge.field === 'time2';
      lockChartForDrag(chart);
      container.style.cursor = isTimeField ? 'ew-resize' : 'ns-resize';
      select(edge.rectId);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: number | null = null;
      return {
        move(mx, my) {
          if (!seriesRef.current) return;
          const value = isTimeField ? pixelToTime(mx) : (magnetSnap(mx, my)?.price ?? null);
          if (value === null) return;
          pending = value;
          throttle(() => {
            if (!active || pending === null) return;
            const r = rects().find(rr => rr.id === edge.rectId);
            if (!r) return;
            const updated: DrawnRect = { ...r, [edge.field]: pending };
            previewAt(r.id, updated.time1, updated.price1, updated.time2, updated.price2);
          });
        },
        end() {
          if (pending !== null) useTraderStore.getState().updateRect(edge.rectId, { [edge.field]: pending });
          active = false;
          pending = null;
          setDragPreview(null);
          sync();
          unlockChartAfterDrag(chart);
        },
      };
    },
  };

  // 枠線をつかんでの平行移動。時間方向は足のインデックス差分で動かす（週末等の足抜けで幅が変わらないように）
  const moveTool: EditTool = {
    hoverCursor: (x, y) => (findBorder(x, y) !== null ? 'move' : null),
    tryStartEdit: (x, y) => {
      const id = findBorder(x, y);
      if (id === null) return null;
      if (!seriesRef.current) return CONSUMED;
      const r = rects().find(rr => rr.id === id);
      const visibleAtDown = displayCandlesRef.current;
      const startTime = pixelToTime(x);
      const startPrice = seriesRef.current.coordinateToPrice(y);
      if (!r || startTime === null || startPrice === null || visibleAtDown.length === 0) return CONSUMED;
      const start = {
        idx1: candleIndexAt(visibleAtDown, r.time1),
        idx2: candleIndexAt(visibleAtDown, r.time2),
        price1: r.price1, price2: r.price2,
        startIdx: candleIndexAt(visibleAtDown, startTime),
        startPrice,
      };
      lockChartForDrag(chart);
      container.style.cursor = 'move';
      select(id);
      const throttle = createFrameThrottle();
      let active = true;
      let pending: { idx: number; dp: number } | null = null;
      const clampIdx = (visible: Candle[], idx: number) => Math.min(Math.max(idx, 0), visible.length - 1);
      return {
        move(mx, my) {
          if (!seriesRef.current) return;
          const t = pixelToTime(mx);
          const p = seriesRef.current.coordinateToPrice(my);
          if (t === null || p === null) return;
          const visibleMove = displayCandlesRef.current;
          if (visibleMove.length === 0) return;
          pending = { idx: candleIndexAt(visibleMove, t) - start.startIdx, dp: p - start.startPrice };
          throttle(() => {
            if (!active || pending === null) return;
            const visibleRaf = displayCandlesRef.current;
            if (visibleRaf.length === 0) return;
            previewAt(
              id,
              visibleRaf[clampIdx(visibleRaf, start.idx1 + pending.idx)].time, start.price1 + pending.dp,
              visibleRaf[clampIdx(visibleRaf, start.idx2 + pending.idx)].time, start.price2 + pending.dp,
            );
          });
        },
        end() {
          if (pending !== null) {
            const visibleUp = displayCandlesRef.current;
            if (visibleUp.length > 0) {
              useTraderStore.getState().updateRect(id, {
                time1: visibleUp[clampIdx(visibleUp, start.idx1 + pending.idx)].time,
                time2: visibleUp[clampIdx(visibleUp, start.idx2 + pending.idx)].time,
                price1: start.price1 + pending.dp,
                price2: start.price2 + pending.dp,
              });
            }
          }
          active = false;
          pending = null;
          setDragPreview(null);
          sync();
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };

  // 角・辺のハンドル（選択中のみ）→枠線の順に試す（ハンドル上のクリックは常にリサイズを優先する）
  const editTool = combineTools([cornerTool, edgeTool, moveTool]);

  return { startDraw, editTool };
}
