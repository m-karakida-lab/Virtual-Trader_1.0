import { describe, expect, it } from 'vitest';
import { plannedRR } from './tradeStats';
import type { ClosedTrade } from '../types';

const t = (over: Partial<ClosedTrade>): ClosedTrade => ({
  id: 1, side: 'BUY', openPrice: 100, closePrice: 101, openTime: 0, closeTime: 1, lots: 1000, pnl: 0, ...over,
});

describe('plannedRR（発注時のリスクリワード比 reward/risk）', () => {
  it('BUY: 損切り1・利確2なら 2', () => expect(plannedRR(t({ sl: 99, tp: 102 }))).toBeCloseTo(2));
  it('SELL でも距離の絶対値で同じ', () => expect(plannedRR(t({ side: 'SELL', sl: 101, tp: 98 }))).toBeCloseTo(2));
  it('TP/SLのどちらかが無ければ null', () => {
    expect(plannedRR(t({ sl: 99 }))).toBeNull();
    expect(plannedRR(t({ tp: 102 }))).toBeNull();
  });
  it('リスク0（SLがエントリーと同値）は null', () => expect(plannedRR(t({ sl: 100, tp: 102 }))).toBeNull());
});
