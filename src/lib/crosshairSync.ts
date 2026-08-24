import type { Candle } from '../types';

// targetTime時点でこのパネルが表示すべき価格（十字カーソルの同期表示用）。
// targetTimeが指す足そのもの、無ければ直前に確定している足の終値を使う。
// 先頭の足より前、または最後の足がまだ閉じていない範囲（先出し防止でこのパネルには
// まだ存在しない未来）の時刻は null を返す。lightweight-charts の setCrosshairPosition は
// 範囲外の時刻を渡しても例外にはならず「別の足」へ無言でスナップしてしまい、パネルごとに
// 全く違う日時の位置に十字カーソルが出ているように見える紛らわしい状態になるため、
// このパネルで意味を持たない時刻は最初から呼ばずに隠す
export function priceAtTime(candles: Candle[], targetTime: number, timeframeSec: number): number | null {
  if (candles.length === 0) return null;
  const first = candles[0], last = candles[candles.length - 1];
  if (targetTime < first.time || targetTime >= last.time + timeframeSec) return null;
  let lo = 0, hi = candles.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= targetTime) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return candles[idx].close;
}
