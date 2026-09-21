import type { Candle } from '../types';

// buckets（時系列昇順の足配列）の中から、boundary（＝「今」の時刻）を含むバケットの
// インデックスを二分探索で返す（見つからなければ-1）。バケット境界はfloor演算で計算し
// 直さず、buckets自身（queryCandlesの集計結果）から引くこと——ブローカー時間バケット
// 境界とJST表示ズレが食い違い、実在しない境界で足を切ってしまう不具合を踏む
export function findBucketIndexContaining(buckets: Candle[], boundary: number): number {
  let lo = 0, hi = buckets.length - 1, bi = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid].time <= boundary) { bi = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return bi;
}

// sourceCandles（0..sourceCursor、先出し防止済みの確定足）のうち
// [bucketStart, bucketEnd) に収まる範囲だけを集計し、まだ確定していない
// 「形成中」の足を作る。範囲内に1本も無ければnullを返す
export function buildPartialCandle(
  sourceCandles: Candle[], sourceCursor: number,
  bucketStart: number, bucketEnd: number,
): Candle | null {
  let open: number | null = null, high = -Infinity, low = Infinity, close = 0;
  for (let i = sourceCursor; i >= 0; i--) {
    const c = sourceCandles[i];
    if (c.time < bucketStart) break;
    if (c.time >= bucketEnd) continue;
    if (open === null) close = c.close;
    open = c.open;
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
  }
  if (open === null) return null;
  return { time: bucketStart, open, high, low, close };
}
