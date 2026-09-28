import type { Candle } from '../../types';

// 時刻tを含む足（t以下で最も新しい足）のインデックス。範囲より前ならt=0番目
export function candleIndexAt(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}
