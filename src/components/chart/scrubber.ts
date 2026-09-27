import type { IChartApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';

export interface ScrubberDeps {
  chartRef: ReadRef<IChartApi | null>;
  trackRef: ReadRef<HTMLDivElement | null>;
  thumbRef: ReadRef<HTMLDivElement | null>;
}

// ── 全期間スクラバー（YouTubeのシークバーのように、全体に対する現在の表示位置・
// 幅をバーで示し、ドラッグで平行移動・クリックでジャンプできるようにする） ──────
// sync: 表示範囲の変化に合わせてつまみの位置・幅を更新する（onRangeChange等から呼ぶ）
// dispose: 生成時に登録したマウスイベントを解除する（CandleChartのeffect cleanupで呼ぶ）
export function createScrubber({ chartRef, trackRef, thumbRef }: ScrubberDeps): { sync: () => void; dispose: () => void } {
  const getTotalBars = () => {
    const { cursor: cur } = useTraderStore.getState();
    return cur + 1;
  };

  const sync = () => {
    if (!chartRef.current || !trackRef.current || !thumbRef.current) return;
    const totalBars = getTotalBars();
    const range = chartRef.current.timeScale().getVisibleLogicalRange();
    const trackWidth = trackRef.current.clientWidth;
    if (totalBars <= 0 || !range || trackWidth <= 0) {
      thumbRef.current.style.display = 'none';
      return;
    }
    const from = Math.max(0, range.from);
    const to = Math.min(totalBars, range.to);
    thumbRef.current.style.display = 'block';
    thumbRef.current.style.left = `${(from / totalBars) * trackWidth}px`;
    thumbRef.current.style.width = `${Math.max(4, ((to - from) / totalBars) * trackWidth)}px`;
  };

  // つまみを掴んだら平行移動、余白をクリックしたらそこを中心にジャンプ（幅＝ズームは変えない）
  let scrubbing = false;
  let scrubStartX = 0;
  let scrubStartRange: { from: number; to: number } | null = null;

  const onDown = (e: MouseEvent) => {
    if (!chartRef.current || !trackRef.current) return;
    const trackRect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - trackRect.left;
    const totalBars = getTotalBars();
    const range = chartRef.current.timeScale().getVisibleLogicalRange();
    if (totalBars <= 0 || !range || trackRect.width <= 0) return;
    const span = range.to - range.from;
    const thumbLeftPx = (Math.max(0, range.from) / totalBars) * trackRect.width;
    const thumbRightPx = (Math.min(totalBars, range.to) / totalBars) * trackRect.width;
    let from: number = range.from;
    let to: number = range.to;
    if (x < thumbLeftPx || x > thumbRightPx) {
      // トラックの余白クリック: そこを中心に瞬時にジャンプしてから、そのままドラッグ継続できる
      const clickBar = (x / trackRect.width) * totalBars;
      from = clickBar - span / 2;
      to = clickBar + span / 2;
      chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
    }
    scrubbing = true;
    scrubStartX = x;
    scrubStartRange = { from, to };
    e.preventDefault();
  };

  const onMove = (e: MouseEvent) => {
    if (!scrubbing || !scrubStartRange || !chartRef.current || !trackRef.current) return;
    const trackRect = trackRef.current.getBoundingClientRect();
    if (trackRect.width <= 0) return;
    const x = e.clientX - trackRect.left;
    const totalBars = getTotalBars();
    if (totalBars <= 0) return;
    const span = scrubStartRange.to - scrubStartRange.from;
    const dxBars = ((x - scrubStartX) / trackRect.width) * totalBars;
    let from = scrubStartRange.from + dxBars;
    let to = scrubStartRange.to + dxBars;
    if (from < 0) { from = 0; to = span; }
    if (to > totalBars) { to = totalBars; from = totalBars - span; }
    chartRef.current.timeScale().setVisibleLogicalRange({ from, to });
  };

  // 普段は薄く、マウスを近づけた時とドラッグ中だけはっきり表示する。
  // ドラッグ中にカーソルがバーの外へ出ても（youtube等と同じく）薄くしない
  let hovering = false;
  const onUp = () => {
    scrubbing = false;
    scrubStartRange = null;
    if (!hovering && trackRef.current) trackRef.current.style.opacity = '0.2';
  };
  const onEnter = () => {
    hovering = true;
    if (trackRef.current) trackRef.current.style.opacity = '1';
  };
  const onLeave = () => {
    hovering = false;
    if (!scrubbing && trackRef.current) trackRef.current.style.opacity = '0.2';
  };

  const track = trackRef.current;
  track?.addEventListener('mousedown', onDown);
  track?.addEventListener('mouseenter', onEnter);
  track?.addEventListener('mouseleave', onLeave);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  const dispose = () => {
    track?.removeEventListener('mousedown', onDown);
    track?.removeEventListener('mouseenter', onEnter);
    track?.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  return { sync, dispose };
}
