import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';
import { CONSUMED, createFrameThrottle, lockChartForDrag, unlockChartAfterDrag, type EditTool } from './drag';

export interface TextMoveToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  textElsRef: ReadRef<Map<number, HTMLDivElement>>;
  findTextNear: (x: number, y: number) => number | null;
  pixelToTime: (x: number) => number | null;
}

// テキストボックスの移動ドラッグ。掴んだ位置と要素の左上とのピクセルオフセットを保ったまま
// DOM要素を直接動かし、mouseupで要素の左上の位置をtime/priceとしてコミットする
export function createTextMoveTool(deps: TextMoveToolDeps): EditTool {
  const { chart, container, seriesRef, textElsRef, findTextNear, pixelToTime } = deps;
  return {
    hoverCursor: (x, y) => (findTextNear(x, y) !== null ? 'move' : null),
    tryStartEdit: (x, y) => {
      const id = findTextNear(x, y);
      if (id === null) return null;
      const el = textElsRef.current.get(id);
      // 実体のDOM要素が無ければ選択だけする（ドラッグは始めない）
      if (!el) {
        useTraderStore.getState().selectLine({ kind: 'text', id });
        return CONSUMED;
      }
      const grabDX = x - el.offsetLeft;
      const grabDY = y - el.offsetTop;
      lockChartForDrag(chart);
      container.style.cursor = 'move';
      useTraderStore.getState().selectLine({ kind: 'text', id });
      const throttle = createFrameThrottle();
      let active = true;
      let pending: { x: number; y: number } | null = null;
      return {
        move(mx, my) {
          pending = { x: mx - grabDX, y: my - grabDY };
          throttle(() => {
            if (!active || pending === null) return;
            const cur = textElsRef.current.get(id);
            if (!cur) return;
            cur.style.left = `${pending.x}px`;
            cur.style.top = `${pending.y}px`;
          });
        },
        end() {
          if (pending !== null && seriesRef.current) {
            const time = pixelToTime(pending.x);
            const price = seriesRef.current.coordinateToPrice(pending.y);
            if (time !== null && price !== null) useTraderStore.getState().updateText(id, { time, price });
          }
          active = false;
          pending = null;
          unlockChartAfterDrag(chart);
          container.style.cursor = 'default';
        },
      };
    },
  };
}
