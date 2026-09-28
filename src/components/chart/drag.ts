import type { IChartApi } from 'lightweight-charts';

// マウス操作の振り分けの部品。mousedownで図形ごとのツールがDragSessionを1つ作り、
// そのドラッグが終わるまでmousemove/mouseupはそのセッションだけが受け取る。
// ドラッグ中の状態（掴んだ図形・保留中の座標等）はセッションのクロージャ内に閉じる
export interface DragSession {
  move(x: number, y: number, e: MouseEvent): void;
  end(x: number, y: number, e: MouseEvent): void;
}

// 既存図形をつかんで編集するツール。当たらなければnullを返し、振り分け側は次のツールを試す
export interface EditTool {
  tryStartEdit(x: number, y: number): DragSession | null;
  // ホバー時のカーソル（当たらなければnull）。判定はtryStartEditと同じ条件にすること
  hoverCursor(x: number, y: number): string | null;
}

// ドラッグ中のプレビュー更新を1フレーム1回に間引く。セッションごとに1つ作る
// （全ドラッグで1つのフラグを共有すると、前のドラッグの予約が次のドラッグの最初の1フレームを食う）
export function createFrameThrottle(): (fn: () => void) => void {
  let scheduled = false;
  let latest: (() => void) | null = null;
  return (fn: () => void) => {
    latest = fn;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const run = latest;
      latest = null;
      run?.();
    });
  };
}

// ドラッグ中はチャート自身のスクロール・拡縮を止める（止めないと図形と一緒にチャートが動く）
export function lockChartForDrag(chart: IChartApi) {
  chart.applyOptions({ handleScroll: false, handleScale: false });
}
export function unlockChartAfterDrag(chart: IChartApi) {
  chart.applyOptions({ handleScroll: true, handleScale: true });
}
