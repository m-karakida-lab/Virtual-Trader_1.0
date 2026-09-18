// 発注パネル（OrderPanel.tsx）のドラッグ位置をlocalStorageへ記憶し、次回起動時に再現する。
// chartViewState.tsと同じ考え方（失敗しても表示位置の記憶が失われるだけで致命的ではない）

const KEY = 'vt:orderPanelPos';

export interface PanelPos {
  x: number;
  y: number;
}

export function loadOrderPanelPos(): PanelPos | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.x === 'number' && typeof v?.y === 'number') return v;
    return null;
  } catch {
    return null;
  }
}

export function saveOrderPanelPos(pos: PanelPos): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pos));
  } catch {
    // 無視（位置の記憶に失敗しても致命的ではない）
  }
}
