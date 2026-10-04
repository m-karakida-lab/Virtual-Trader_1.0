import { describe, expect, it } from 'vitest';
import { computeBB, computeCloud, computeEMA, computeSMA, computeTail } from './indicators';
import type { Candle } from '../types';

// 決定的な疑似乱数の足列（再現できること）
function makeCandles(n: number, step = 3600): Candle[] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out: Candle[] = [];
  let p = 110;
  for (let i = 0; i < n; i++) {
    const o = p;
    p += (rnd() - 0.5) * 0.4;
    out.push({ time: 1_450_000_000 + i * step, open: o, high: Math.max(o, p) + rnd() * 0.1, low: Math.min(o, p) - rnd() * 0.1, close: p });
  }
  return out;
}

// 再生中の非メインパネルは末尾だけをcomputeTailで差分更新する。その結果は、全体を計算し直した
// 値の末尾と一致していなければならない（一致しないと再生中だけ指標線が全体計算とズレる）
describe('computeTail は全体計算の末尾と一致する', () => {
  const cs = makeCandles(600);
  const tf = 3600;
  const from = 590;
  const emaFull = computeEMA(cs);
  const emaBefore = emaFull[emaFull.length - 1 - (cs.length - from)].value;
  const tail = computeTail(cs, from, tf, cs, emaBefore);
  const n = cs.length - from;
  const last = <T,>(a: T[]) => a.slice(a.length - n);

  const close = (a: { time: unknown; value: number }[], b: { time: unknown; value: number }[]) => {
    expect(a).toHaveLength(b.length);
    a.forEach((x, i) => { expect(x.time).toBe(b[i].time); expect(x.value).toBeCloseTo(b[i].value, 9); });
  };

  it('EMA', () => close(tail.ema, last(emaFull)));
  it('SMA', () => close(tail.sma, last(computeSMA(cs))));
  it('ボリンジャーバンド（基準線・±2σ）', () => {
    const bb = computeBB(cs);
    close(tail.bb.basis, last(bb.basis));
    close(tail.bb.upper2, last(bb.upper2));
    close(tail.bb.lower2, last(bb.lower2));
  });
  it('雲（先行スパンA/B）', () => {
    const cloud = computeCloud(cs, tf, cs);
    close(tail.senkouA, last(cloud.senkouA));
    close(tail.senkouB, last(cloud.senkouB));
  });
  it('次回用のEMA値（末尾の1本前）', () => {
    expect(tail.emaAtClosed).toBeCloseTo(emaFull[emaFull.length - 2].value, 9);
  });
});
