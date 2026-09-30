// トレード日誌メモ窓（TradeMemoWindow.tsx）の位置・大きさをlocalStorageへ記憶する。
// orderPanelPos.tsと同じ考え方（失敗しても記憶が失われるだけで致命的ではない）

const KEY = 'vt:tradeMemoWin';

export interface MemoWinRect { x: number; y: number; w: number; h: number }

export const DEFAULT_MEMO_WIN: MemoWinRect = { x: 80, y: 90, w: 360, h: 240 };

export function loadMemoWin(): MemoWinRect {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if ([v?.x, v?.y, v?.w, v?.h].every(n => typeof n === 'number' && Number.isFinite(n))) return v;
  } catch { /* 無視 */ }
  return DEFAULT_MEMO_WIN;
}

export function saveMemoWin(r: MemoWinRect): void {
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* 無視 */ }
}
