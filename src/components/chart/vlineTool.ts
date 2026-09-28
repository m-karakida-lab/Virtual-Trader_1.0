import type { IChartApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';
import { createFrameThrottle, lockChartForDrag, unlockChartAfterDrag, type EditTool } from './drag';

export interface VLineToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  findVLineNear: (x: number) => number | null;
  vlineElsRef: ReadRef<Map<number, HTMLDivElement>>;
  lineHandleElRef: ReadRef<HTMLDivElement | null>;
  // 線本体（linesOverlayのcanvas）のドラッグ中プレビュー座標
  setDragPreview: (p: { id: number; x: number } | null) => void;
  drawVLineCanvas: () => void;
}

// 垂直線のドラッグ移動。ドラッグ中はstoreを経由せず、日付ラベル・中点ハンドル（DOM）と
// 線本体（canvas）を1フレーム1回だけ直接動かし、mouseupでstoreへコミットする
export function createVLineTool(deps: VLineToolDeps): EditTool {
  const { chart, container, findVLineNear, vlineElsRef, lineHandleElRef, setDragPreview, drawVLineCanvas } = deps;
  return {
    hoverCursor: (x) => (findVLineNear(x) !== null ? 'ew-resize' : null),
    tryStartEdit: (x) => {
      const id = findVLineNear(x);
      if (id === null) return null;
      lockChartForDrag(chart);
      container.style.cursor = 'ew-resize';
      useTraderStore.getState().selectLine({ kind: 'v', id });
      const throttle = createFrameThrottle();
      let active = true;
      let pendingX: number | null = null;
      return {
        move(mx) {
          pendingX = mx;
          throttle(() => {
            if (!active || pendingX === null) return;
            const el = vlineElsRef.current.get(id);
            if (el) el.style.left = `${pendingX}px`;
            // 中点ハンドルも同じフレームで追従させる（理由は水平線ドラッグと同じ）
            if (lineHandleElRef.current) lineHandleElRef.current.style.left = `${pendingX - 4}px`;
            // 線本体（canvas描画）もこのフレームで追従させないと、DOMのラベル/ハンドルだけ
            // 動いて線の見た目が古い位置に取り残される
            setDragPreview({ id, x: pendingX });
            drawVLineCanvas();
          });
        },
        end() {
          if (pendingX !== null) {
            const time = chart.timeScale().coordinateToTime(pendingX);
            if (time !== null) useTraderStore.getState().updateVLine(id, { time: time as number });
          }
          active = false;
          pendingX = null;
          setDragPreview(null);
          drawVLineCanvas(); // storeコミット後の実データで再描画（プレビュー座標を使い続けない）
          unlockChartAfterDrag(chart);
        },
      };
    },
  };
}
