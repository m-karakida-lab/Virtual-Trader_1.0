import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle, LineSelection } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef, TimeToX } from './refs';
import type { PxSegment, TwoPointDrag } from './trendLinesOverlay';
import { candleIndexAt } from './candleIndex';
import {
  CONSUMED, combineTools, createFrameThrottle, lockChartForDrag, unlockChartAfterDrag,
  type DragSession, type EditTool,
} from './drag';

export type TwoPointShape = { id: number; time1: number; price1: number; time2: number; price2: number };
type TwoPointPatch = Partial<Pick<TwoPointShape, 'time1' | 'price1' | 'time2' | 'price2'>>;
export type EndpointHit = { id: number; timeField: 'time1' | 'time2'; priceField: 'price1' | 'price2' };

export interface TwoPointToolDeps<S extends TwoPointShape> {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  selectionKind: LineSelection['kind'];
  // 平行チャネルは基準線側の操作として選択する（part: 'base'）
  selectionPart?: LineSelection['part'];
  list: () => S[];
  add: (time1: number, price1: number, time2: number, price2: number) => void;
  update: (id: number, patch: TwoPointPatch) => void;
  // 端点ハンドル（選択中の図形のみ）・線分本体の当たり判定
  findEndpoint: (x: number, y: number) => EndpointHit | null;
  findBody: (x: number, y: number) => number | null;
  // 描画モジュールが読むドラッグ中/新規描画中の状態と、その描き直し。shapeはドラッグ中の図形の
  // 現在のstore上の値（平行チャネルはここからoffsetを引き継いでプレビューする）
  setDragPreview: (p: TwoPointDrag | null, shape?: S) => void;
  setNewDraft: (d: PxSegment | null) => void;
  sync: () => void;
  magnetSnap: (x: number, y: number) => { price: number; y: number } | null;
  pixelToTime: (x: number) => number | null;
  timeToX: TimeToX;
  // Shiftを押しながら新規描画・端点ドラッグすると、反対側の点を基準に水平/垂直へ強制する（矢印のみ）
  shiftConstrains?: boolean;
  // 端点ドラッグの確定後にカーソルを既定に戻す（平行チャネル）
  resetCursorAfterEndpoint?: boolean;
}

// 2点図形（トレンドライン・矢印）のマウス操作: 新規描画（ドラッグ）、端点のリサイズ、
// 本体の平行移動。ドラッグ中はstoreを経由せずプレビューだけ描き直し、mouseupでコミットする
export function createTwoPointTool<S extends TwoPointShape>(deps: TwoPointToolDeps<S>) {
  const {
    chart, container, seriesRef, displayCandlesRef, selectionKind, selectionPart, list, add, update,
    findEndpoint, findBody, setDragPreview, setNewDraft, sync, magnetSnap, pixelToTime, timeToX,
    shiftConstrains = false, resetCursorAfterEndpoint = false,
  } = deps;
  const select = (id: number) => useTraderStore.getState().selectLine(
    selectionPart ? { kind: selectionKind, id, part: selectionPart } : { kind: selectionKind, id },
  );

  // 新規描画: 始点から現在位置までの線分をピクセル座標のままプレビューし、離した時に追加する
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
      move(mx, my, e) {
        const s = magnetSnap(mx, my);
        if (s === null) return;
        pendingEnd = { x: mx, y: s.y, price: s.price };
        // Shift: 始点を基準に、カーソルが横寄りなら水平（始点と同じ価格）、縦寄りなら垂直（始点と同じ時刻）
        if (shiftConstrains && e.shiftKey) {
          if (Math.abs(mx - start.x) >= Math.abs(my - start.y)) pendingEnd = { x: mx, y: start.y, price: start.price };
          else pendingEnd = { x: start.x, y: s.y, price: s.price };
        }
        setNewDraft({ x1: start.x, y1: start.y, x2: pendingEnd.x, y2: pendingEnd.y });
        sync();
      },
      end() {
        unlockChartAfterDrag(chart);
        setNewDraft(null);
        const t1 = pixelToTime(start.x);
        const t2 = pixelToTime(pendingEnd.x);
        const p1 = start.price;
        const p2 = pendingEnd.price;
        if (t1 !== null && t2 !== null && (t1 !== t2 || p1 !== p2)) add(t1, p1, t2, p2);
        sync(); // ドラフトのクリア（実際に追加された場合はstore更新側の再描画とも重複するが無害）
      },
    };
  };

  // 端点のリサイズ: 掴んだ側の端点だけ動かし、反対側は固定する
  const startEndpointDrag = (hit: EndpointHit): DragSession => {
    lockChartForDrag(chart);
    container.style.cursor = 'nwse-resize';
    select(hit.id);
    const throttle = createFrameThrottle();
    let active = true;
    let pending: { time: number; price: number } | null = null;
    return {
      move(x, y, e) {
        if (!seriesRef.current) return;
        let price = magnetSnap(x, y)?.price ?? null;
        let time = pixelToTime(x);
        if (price === null || time === null) return;
        // Shiftを押しながら端点をドラッグすると、もう一方の端点（固定点）を基準に
        // 水平（同じ価格）か垂直（同じ時刻）のどちらか一方に強制する。カーソルの実際の
        // 移動方向（ピクセル距離が大きい方の軸）で水平/垂直を自動判定する
        if (shiftConstrains && e.shiftKey) {
          const shape = list().find(o => o.id === hit.id);
          if (shape) {
            const fixedTime = hit.timeField === 'time1' ? shape.time2 : shape.time1;
            const fixedPrice = hit.priceField === 'price1' ? shape.price2 : shape.price1;
            const fixedX = timeToX(fixedTime);
            const fixedY = seriesRef.current.priceToCoordinate(fixedPrice);
            if (fixedX !== null && fixedY !== null) {
              if (Math.abs(x - fixedX) >= Math.abs(y - fixedY)) price = fixedPrice;
              else time = fixedTime;
            }
          }
        }
        pending = { time, price };
        throttle(() => {
          if (!active || pending === null) return;
          const shape = list().find(o => o.id === hit.id);
          if (!shape) return;
          setDragPreview({
            id: shape.id,
            time1: hit.timeField === 'time1' ? pending.time : shape.time1,
            price1: hit.priceField === 'price1' ? pending.price : shape.price1,
            time2: hit.timeField === 'time2' ? pending.time : shape.time2,
            price2: hit.priceField === 'price2' ? pending.price : shape.price2,
          }, shape);
          sync();
        });
      },
      end() {
        if (pending !== null) update(hit.id, { [hit.timeField]: pending.time, [hit.priceField]: pending.price });
        active = false;
        pending = null;
        setDragPreview(null);
        unlockChartAfterDrag(chart);
        if (resetCursorAfterEndpoint) container.style.cursor = 'default';
      },
    };
  };

  // 本体の平行移動。時間方向は秒数ではなく足のインデックス差分で動かす（週末等で足が抜けている
  // 区間をまたいでも、両端に同じ本数を足すので幅が変わらない）
  const startBodyMove = (id: number, x: number, y: number): DragSession | typeof CONSUMED => {
    if (!seriesRef.current) return CONSUMED;
    const shape = list().find(o => o.id === id);
    const visibleAtDown = displayCandlesRef.current;
    const startTime = pixelToTime(x);
    const startPrice = seriesRef.current.coordinateToPrice(y);
    if (!shape || startTime === null || startPrice === null || visibleAtDown.length === 0) return CONSUMED;
    const start = {
      idx1: candleIndexAt(visibleAtDown, shape.time1),
      idx2: candleIndexAt(visibleAtDown, shape.time2),
      price1: shape.price1, price2: shape.price2,
      startIdx: candleIndexAt(visibleAtDown, startTime),
      startPrice,
    };
    lockChartForDrag(chart);
    container.style.cursor = 'move';
    select(id);
    const throttle = createFrameThrottle();
    let active = true;
    let pending: { idx: number; dp: number } | null = null;
    // 移動後の両端の時刻・価格（足のインデックスは表示中の足の範囲にクランプする）
    const moved = (visible: Candle[], delta: { idx: number; dp: number }) => {
      const newIdx1 = Math.min(Math.max(start.idx1 + delta.idx, 0), visible.length - 1);
      const newIdx2 = Math.min(Math.max(start.idx2 + delta.idx, 0), visible.length - 1);
      return {
        time1: visible[newIdx1].time, price1: start.price1 + delta.dp,
        time2: visible[newIdx2].time, price2: start.price2 + delta.dp,
      };
    };
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
          setDragPreview({ id, ...moved(visibleRaf, pending) }, list().find(o => o.id === id));
          sync();
        });
      },
      end() {
        if (pending !== null) {
          const visibleUp = displayCandlesRef.current;
          if (visibleUp.length > 0) {
            const m = moved(visibleUp, pending);
            update(id, { time1: m.time1, time2: m.time2, price1: m.price1, price2: m.price2 });
          }
        }
        active = false;
        pending = null;
        setDragPreview(null);
        unlockChartAfterDrag(chart);
        container.style.cursor = 'default';
      },
    };
  };

  // 端点・本体を別々のツールとしても出す（平行チャネルは間にオフセット線の判定を挟む）
  const endpointTool: EditTool = {
    hoverCursor: (x, y) => (findEndpoint(x, y) !== null ? 'nwse-resize' : null),
    tryStartEdit: (x, y) => {
      const hit = findEndpoint(x, y);
      return hit !== null ? startEndpointDrag(hit) : null;
    },
  };
  const bodyTool: EditTool = {
    hoverCursor: (x, y) => (findBody(x, y) !== null ? 'move' : null),
    tryStartEdit: (x, y) => {
      const bodyId = findBody(x, y);
      return bodyId !== null ? startBodyMove(bodyId, x, y) : null;
    },
  };
  // 端点（選択中のみ）→本体の順に試す
  const editTool = combineTools([endpointTool, bodyTool]);

  return { startDraw, editTool, endpointTool, bodyTool };
}
