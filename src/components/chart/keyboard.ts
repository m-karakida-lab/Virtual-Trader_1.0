import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { LineSelection } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef, TimeToX } from './refs';

// ペースト後はクリップボードを複製先に差し替える。連続でVを押すと
// その都度PASTE_OFFSET_PXずつ右下へずれながら複製されていく（斜めに並ぶ）
const PASTE_OFFSET_PX = 20;

// Cmd/Ctrl+C→Vのクリップボード。モジュールスコープに置いて全パネル（CandleChartの全インスタンス）で
// 共有する。インスタンスごとに持つと「パネルAでコピーしたものをパネルBでペースト」した時にBの空の
// クリップボードが空振りする。同じキー入力に全インスタンスが反応しないよう、onKeyDown側で
// activePanelSlot（最後にマウス操作した1枠）だけを通す
let clipboard: LineSelection | null = null;

type TraderState = ReturnType<typeof useTraderStore.getState>;
type TwoPointShape = { id: number; time1: number; price1: number; time2: number; price2: number };

// 2点図形（四角形・トレンドライン・平行チャネル・矢印）のペースト: 両端を同じピクセル量だけずらして複製する
const TWO_POINT_PASTE: Partial<Record<LineSelection['kind'], {
  list: (s: TraderState) => TwoPointShape[];
  duplicate: (s: TraderState, id: number, time1: number, price1: number, time2: number, price2: number) => void;
  nextId: (s: TraderState) => number;
}>> = {
  rect: { list: s => s.rects, duplicate: (s, ...a) => s.duplicateRect(...a), nextId: s => s.nextRectId },
  trend: { list: s => s.trendLines, duplicate: (s, ...a) => s.duplicateTrendLine(...a), nextId: s => s.nextTrendLineId },
  channel: { list: s => s.channels, duplicate: (s, ...a) => s.duplicateChannel(...a), nextId: s => s.nextChannelId },
  arrow: { list: s => s.arrows, duplicate: (s, ...a) => s.duplicateArrow(...a), nextId: s => s.nextArrowId },
};

export interface KeyboardDeps {
  slotRef: ReadRef<number>;
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  timeToX: TimeToX;
  pixelToTime: (x: number) => number | null;
}

// Delete/Backspaceキーで選択中の図形を削除、Cmd/Ctrl+Zで取り消し、Cmd/Ctrl+C・Vでコピー&ペースト
// （Macのキーボードは物理削除キーが実は⌫=Backspaceで、fn+⌫でようやくDeleteになるため両方拾う）。
// windowのkeydownに登録する関数を返す（登録・解除はCandleChart側）
export function createKeyboardHandler(deps: KeyboardDeps): (e: KeyboardEvent) => void {
  const { slotRef, chartRef, seriesRef, timeToX, pixelToTime } = deps;

  const paste = (series: ISeriesApi<'Candlestick'>, cb: LineSelection) => {
    const store = useTraderStore.getState();
    const select = (kind: LineSelection['kind'], id: number) => {
      store.selectLine({ kind, id });
      clipboard = { kind, id };
    };
    const twoPoint = TWO_POINT_PASTE[cb.kind];
    if (twoPoint) {
      const src = twoPoint.list(store).find(o => o.id === cb.id);
      if (!src) return;
      const x1 = timeToX(src.time1), x2 = timeToX(src.time2);
      const y1 = series.priceToCoordinate(src.price1), y2 = series.priceToCoordinate(src.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) return;
      const newTime1 = pixelToTime(x1 + PASTE_OFFSET_PX);
      const newTime2 = pixelToTime(x2 + PASTE_OFFSET_PX);
      const newPrice1 = series.coordinateToPrice(y1 + PASTE_OFFSET_PX);
      const newPrice2 = series.coordinateToPrice(y2 + PASTE_OFFSET_PX);
      if (newTime1 === null || newTime2 === null || newPrice1 === null || newPrice2 === null) return;
      twoPoint.duplicate(store, src.id, newTime1, newPrice1, newTime2, newPrice2);
      select(cb.kind, twoPoint.nextId(useTraderStore.getState()) - 1);
    } else if (cb.kind === 'h') {
      const src = store.lines.find(l => l.id === cb.id);
      const y = src && series.priceToCoordinate(src.price);
      if (!src || y === null || y === undefined) return;
      const newPrice = series.coordinateToPrice(y + PASTE_OFFSET_PX);
      if (newPrice === null) return;
      store.duplicateLine(src.id, newPrice);
      select('h', useTraderStore.getState().nextLineId - 1);
    } else if (cb.kind === 'v') {
      const src = store.vlines.find(v => v.id === cb.id);
      const x = src && timeToX(src.time);
      if (!src || x === null || x === undefined) return;
      const newTime = pixelToTime(x + PASTE_OFFSET_PX);
      if (newTime === null) return;
      store.duplicateVLine(src.id, newTime);
      select('v', useTraderStore.getState().nextVLineId - 1);
    } else if (cb.kind === 'brush') {
      const src = store.brushes.find(b => b.id === cb.id);
      if (!src) return;
      // 各点を同じピクセル量だけずらす（先頭点のオフセットをtime/priceの差分に変換し、全点へ適用）
      const x0 = timeToX(src.points[0].time), y0 = series.priceToCoordinate(src.points[0].price);
      if (x0 === null || y0 === null) return;
      const newTime0 = pixelToTime(x0 + PASTE_OFFSET_PX);
      const newPrice0 = series.coordinateToPrice(y0 + PASTE_OFFSET_PX);
      if (newTime0 === null || newPrice0 === null) return;
      const dt = newTime0 - src.points[0].time, dp = newPrice0 - src.points[0].price;
      const newPoints = src.points.map(p => ({ time: p.time + dt, price: p.price + dp }));
      store.duplicateBrush(src.id, newPoints);
      select('brush', useTraderStore.getState().nextBrushId - 1);
    } else {
      const src = store.texts.find(t => t.id === cb.id);
      if (!src) return;
      const x = timeToX(src.time), y = series.priceToCoordinate(src.price);
      if (x === null || y === null) return;
      const newTime = pixelToTime(x + PASTE_OFFSET_PX);
      const newPrice = series.coordinateToPrice(y + PASTE_OFFSET_PX);
      if (newTime === null || newPrice === null) return;
      store.duplicateText(src.id, newTime, newPrice);
      select('text', useTraderStore.getState().nextTextId - 1);
    }
  };

  return (e: KeyboardEvent) => {
    // 4画面時、Delete/Undo/コピペ等は「最後にマウス操作した1枠」だけに効かせる
    // （全インスタンスがwindowのkeydownを見ているため、絞らないと同じキー入力に
    // 全枠が反応してしまう。例: Cmd+Vで意図せず4つ複製される）
    if (useTraderStore.getState().activePanelSlot !== slotRef.current) return;
    const active = document.activeElement as HTMLElement | null;
    const tag = (active?.tagName || '').toLowerCase();
    // テキストボックスの直接編集中（contentEditable）もショートカット対象から除外する
    if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const { selected: sel, removeLine, removeVLine, removeRect, removeTrendLine, removeChannel, removeArrow, removeBrush, removeText } = useTraderStore.getState();
      if (!sel) return;
      if (sel.kind === 'h') removeLine(sel.id);
      else if (sel.kind === 'v') removeVLine(sel.id);
      else if (sel.kind === 'rect') removeRect(sel.id);
      else if (sel.kind === 'trend') removeTrendLine(sel.id);
      else if (sel.kind === 'channel') removeChannel(sel.id);
      else if (sel.kind === 'arrow') removeArrow(sel.id);
      else if (sel.kind === 'brush') removeBrush(sel.id);
      else removeText(sel.id);
      return;
    }

    if (!(e.metaKey || e.ctrlKey)) return;

    if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      useTraderStore.getState().undo();
      return;
    }

    if (!seriesRef.current || !chartRef.current) return;

    if (e.key === 'c' || e.key === 'C') {
      const { selected: sel } = useTraderStore.getState();
      if (sel) clipboard = sel;
      return;
    }

    if (e.key === 'v' || e.key === 'V') {
      if (!clipboard) return;
      e.preventDefault();
      paste(seriesRef.current, clipboard);
    }
  };
}
