import type { IChartApi, IPriceLine, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';
import type { DragTarget } from './hitTest';
import { createFrameThrottle, lockChartForDrag, unlockChartAfterDrag, type DragSession, type EditTool } from './drag';

type DraftKind = 'price' | 'tp' | 'sl';

export interface PriceLineToolDeps {
  chart: IChartApi;
  container: HTMLDivElement;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  findDraftNear: (y: number) => DraftKind | null;
  findPriceTargetNear: (y: number) => DragTarget | null;
  findHLineNear: (y: number) => number | null;
  // ドラッグ中はstoreを経由せず、チャート側の価格ライン（createPriceLine）を直接動かす
  priceLineMapFor: (kind: DragTarget['kind']) => Map<number, IPriceLine>;
  // 水平線の中点ハンドル（DOM）と線本体（linesOverlayのcanvas）
  lineHandleElRef: ReadRef<HTMLDivElement | null>;
  setHLineDragPreview: (p: { id: number; price: number } | null) => void;
  drawHLineCanvas: () => void;
  magnetSnap: (x: number, y: number) => { price: number; y: number } | null;
}

// 価格方向にだけ動かすラインのドラッグ: 発注パネルの下書き（価格/TP/SL）、未約定注文とTP/SL・
// ポジションのTP/SL、水平線。どれも上下のドラッグで価格を変える
export function createPriceLineTools(deps: PriceLineToolDeps) {
  const {
    chart, container, seriesRef, findDraftNear, findPriceTargetNear, findHLineNear, priceLineMapFor,
    lineHandleElRef, setHLineDragPreview, drawHLineCanvas, magnetSnap,
  } = deps;

  const commitDraft = (kind: DraftKind, price: number) => {
    const store = useTraderStore.getState();
    if (kind === 'price') store.setDraftPrice(price);
    else if (kind === 'tp') store.setDraftTP(price);
    else store.setDraftSL(price);
  };

  // 発注パネルの下書き（価格/TP/SL）。下書きはstore値そのものなので、ドラッグ中も1フレーム1回
  // storeへ直接コミットする（既存の描画系がそのまま追従する）。選択状態は変えない
  const draftTool: EditTool = {
    hoverCursor: (_x, y) => (findDraftNear(y) !== null ? 'ns-resize' : null),
    tryStartEdit: (_x, y) => {
      const kind = findDraftNear(y);
      if (kind === null) return null;
      lockChartForDrag(chart);
      container.style.cursor = 'ns-resize';
      const throttle = createFrameThrottle();
      let active = true;
      let pending: number | null = null;
      return {
        move(_mx, my) {
          if (!seriesRef.current) return;
          const price = seriesRef.current.coordinateToPrice(my);
          if (price === null) return;
          pending = price;
          throttle(() => {
            if (active && pending !== null) commitDraft(kind, pending);
          });
        },
        end() {
          // 最後のmousemoveのコミットがまだ走っていなければここで確定させる
          // （素早く離した時の最後の移動を失わないように）
          if (pending !== null) commitDraft(kind, pending);
          active = false;
          pending = null;
          unlockChartAfterDrag(chart);
        },
      };
    },
  };

  // 注文・TP/SL・水平線のドラッグ。水平線だけは描画ツールとしてマグネットの対象にし、中点ハンドルと
  // 線本体（canvas）も同じフレームで動かす。価格は丸めない（量子化するとズーム次第で数px単位で飛ぶ）
  const startLineDrag = (target: DragTarget): DragSession => {
    lockChartForDrag(chart);
    container.style.cursor = 'ns-resize';
    const isHLine = target.kind === 'hline';
    const throttle = createFrameThrottle();
    let active = true;
    let pending: number | null = null;
    return {
      move(mx, my) {
        if (!seriesRef.current) return;
        const price = isHLine ? magnetSnap(mx, my)?.price ?? null : seriesRef.current.coordinateToPrice(my);
        if (price === null) return;
        pending = price;
        throttle(() => {
          if (!active || pending === null) return;
          priceLineMapFor(target.kind).get(target.id)?.applyOptions({ price: pending });
          if (isHLine && lineHandleElRef.current && seriesRef.current) {
            const hy = seriesRef.current.priceToCoordinate(pending);
            if (hy !== null) lineHandleElRef.current.style.top = `${hy - 4}px`;
          }
          if (isHLine) {
            setHLineDragPreview({ id: target.id, price: pending });
            drawHLineCanvas();
          }
        });
      },
      end() {
        if (pending !== null) {
          const store = useTraderStore.getState();
          if (target.kind === 'hline') store.updateLine(target.id, { price: pending });
          else if (target.kind === 'order') store.updateOrderPrice(target.id, pending);
          else if (target.kind === 'tp') store.setPositionTP(target.id, pending);
          else if (target.kind === 'sl') store.setPositionSL(target.id, pending);
          else if (target.kind === 'orderTp') store.setOrderTP(target.id, pending);
          else store.setOrderSL(target.id, pending);
        }
        if (isHLine) {
          setHLineDragPreview(null);
          drawHLineCanvas(); // storeコミット後の実データで再描画（プレビュー価格を使い続けない）
        }
        active = false;
        pending = null;
        unlockChartAfterDrag(chart);
      },
    };
  };

  // 未約定注文とそのTP/SL、ポジションのTP/SL
  const priceTargetTool: EditTool = {
    hoverCursor: (_x, y) => (findPriceTargetNear(y) !== null ? 'ns-resize' : null),
    tryStartEdit: (_x, y) => {
      const target = findPriceTargetNear(y);
      return target !== null ? startLineDrag(target) : null;
    },
  };

  // 水平線。画面全幅で当たるため、優先順位の一覧では最後に置く（四角形等の編集を優先する）
  const hlineTool: EditTool = {
    hoverCursor: (_x, y) => (findHLineNear(y) !== null ? 'ns-resize' : null),
    tryStartEdit: (_x, y) => {
      const id = findHLineNear(y);
      if (id === null) return null;
      const session = startLineDrag({ kind: 'hline', id });
      useTraderStore.getState().selectLine({ kind: 'h', id });
      return session;
    },
  };

  return { draftTool, priceTargetTool, hlineTool };
}
