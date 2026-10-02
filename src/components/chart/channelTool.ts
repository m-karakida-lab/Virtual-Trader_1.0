import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle, DrawnChannel } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, ReadRef, TimeToX } from './refs';
import type { PxSegment, TwoPointDrag } from './trendLinesOverlay';
import { interpolatePriceOnLine } from './coordinates';
import { createTwoPointTool, type EndpointHit } from './twoPointTool';
import {
  CONSUMED, combineTools, createFrameThrottle, lockChartForDrag, unlockChartAfterDrag,
  type DragSession, type EditTool,
} from './drag';

type BaseLine = { time1: number; price1: number; time2: number; price2: number };

export interface ChannelToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  findEndpoint: (x: number, y: number) => EndpointHit | null;
  findBase: (x: number, y: number) => number | null;
  findOffsetLine: (x: number, y: number) => number | null;
  // 描画モジュール（channelsOverlay）が読む状態。オフセット決定待ちの状態は描画ツールの
  // 切替時にCandleChart側（cancelChannelAwaitRef）からも破棄されるため、CandleChartが持つ
  setDragPreview: (p: (TwoPointDrag & { offset: number }) | null) => void;
  setNewDraft: (d: PxSegment | null) => void;
  getAwaitingOffset: Getter<BaseLine | null>;
  setAwaitingOffset: (b: BaseLine | null) => void;
  setOffsetPreview: (offset: number | null) => void;
  sync: () => void;
  magnetSnap: (x: number, y: number) => { price: number; y: number } | null;
  pixelToTime: (x: number) => number | null;
  timeToX: TimeToX;
}

// 平行チャネルのマウス操作。新規描画は2段階: 1回目のドラッグで基準線を決め（まだstoreに
// 追加しない）、続くマウス移動で2本目までの幅をプレビューし、クリックで幅を確定して追加する。
// 既存チャネルは基準線の端点・本体をトレンドラインと同じ操作で、2本目（オフセット線）は
// 上下の平行移動で幅を調整する
export function createChannelTool(deps: ChannelToolDeps) {
  const {
    chart, container, seriesRef, findOffsetLine, setDragPreview, getAwaitingOffset, setAwaitingOffset,
    setOffsetPreview, sync, magnetSnap, pixelToTime,
  } = deps;
  const channels = () => useTraderStore.getState().channels;

  const twoPoint = createTwoPointTool<DrawnChannel>({
    chart: deps.chart, container: deps.container, seriesRef: deps.seriesRef, displayCandlesRef: deps.displayCandlesRef,
    magnetSnap: deps.magnetSnap, pixelToTime: deps.pixelToTime, timeToX: deps.timeToX,
    selectionKind: 'channel', selectionPart: 'base', resetCursorAfterEndpoint: true,
    // Shiftで基準線を水平にする（新規描画・端点ドラッグとも）
    shiftConstrains: 'horizontal',
    list: channels,
    // 基準線のドラッグは確定させず、オフセット決定待ちに移る（ドラッグせず単にクリックした
    // だけ＝始点と終点が同じなら何も始めず、ツールをアクティブなまま維持する）
    add: (time1, price1, time2, price2) => {
      setAwaitingOffset({ time1, price1, time2, price2 });
      setOffsetPreview(0);
    },
    update: (id, patch) => useTraderStore.getState().updateChannel(id, patch),
    findEndpoint: deps.findEndpoint, findBody: deps.findBase,
    setDragPreview: (p, shape) => setDragPreview(p && shape ? { ...p, offset: shape.offset } : null),
    setNewDraft: deps.setNewDraft, sync,
  });

  // 基準線からみたカーソル位置の価格差（=オフセット）。基準線を時間方向に延長した直線上で比べる
  const offsetAt = (base: BaseLine, x: number, price: number) => {
    const atTime = pixelToTime(x) ?? base.time1;
    return price - interpolatePriceOnLine(base.time1, base.price1, base.time2, base.price2, atTime);
  };

  // 描画ツール選択中のmousedown。オフセット決定待ちならこのクリックで幅を確定して追加する
  const startDraw = (x: number, y: number): DragSession | null => {
    if (!seriesRef.current) return null;
    const awaiting = getAwaitingOffset();
    if (awaiting) {
      const snap = magnetSnap(x, y);
      if (snap === null) return null;
      const { time1, price1, time2, price2 } = awaiting;
      useTraderStore.getState().addChannel(time1, price1, time2, price2, offsetAt(awaiting, x, snap.price));
      setAwaitingOffset(null);
      setOffsetPreview(null);
      sync();
      return null;
    }
    return twoPoint.startDraw(x, y);
  };

  // オフセット決定待ちの間は、ボタンを押していないマウス移動で2本目の位置をプレビューする。
  // 処理した（決定待ちだった）ならtrue
  const moveWhileAwaitingOffset = (x: number, y: number): boolean => {
    const awaiting = getAwaitingOffset();
    if (!awaiting) return false;
    const snap = magnetSnap(x, y);
    if (snap === null) return true;
    setOffsetPreview(offsetAt(awaiting, x, snap.price));
    sync();
    return true;
  };

  // 2本目（オフセット線）の上下ドラッグで幅（offset）だけを変える
  const offsetTool: EditTool = {
    hoverCursor: (x, y) => (findOffsetLine(x, y) !== null ? 'ns-resize' : null),
    tryStartEdit: (x, y) => {
      const id = findOffsetLine(x, y);
      if (id === null) return null;
      if (!seriesRef.current) return CONSUMED;
      const ch = channels().find(c => c.id === id);
      const startPrice = seriesRef.current.coordinateToPrice(y);
      if (!ch || startPrice === null) return CONSUMED;
      const baseOffset = ch.offset;
      lockChartForDrag(chart);
      // オフセット線は上下（価格）方向の幅調整専用の操作なので、水平線と同じns-resizeカーソルにする
      container.style.cursor = 'ns-resize';
      useTraderStore.getState().selectLine({ kind: 'channel', id, part: 'offset' });
      const throttle = createFrameThrottle();
      let active = true;
      let pending: number | null = null;
      return {
        move(_x, my) {
          if (!seriesRef.current) return;
          const p = seriesRef.current.coordinateToPrice(my);
          if (p === null) return;
          pending = baseOffset + (p - startPrice);
          throttle(() => {
            if (!active || pending === null) return;
            const cur = channels().find(c => c.id === id);
            if (!cur) return;
            setDragPreview({ id: cur.id, time1: cur.time1, price1: cur.price1, time2: cur.time2, price2: cur.price2, offset: pending });
            sync();
          });
        },
        end() {
          if (pending !== null) useTraderStore.getState().updateChannel(id, { offset: pending });
          active = false;
          pending = null;
          setDragPreview(null);
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };

  // 端点（選択中のみ）→オフセット線→基準線の順に試す。オフセット線を基準線より先にするのは、
  // 幅が狭い時に先に判定した方が優先的に掴めてしまうため、より細い操作対象を優先する
  const editTool = combineTools([twoPoint.endpointTool, offsetTool, twoPoint.bodyTool]);

  return { startDraw, moveWhileAwaitingOffset, editTool };
}
