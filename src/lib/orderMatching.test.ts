import { describe, expect, it } from 'vitest';
import { processOrderRange } from './orderMatching';
import type { Candle, PendingOrder, Position } from '../types';

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });
const pos = (over: Partial<Position>): Position => ({ id: 1, side: 'BUY', openPrice: 100, lots: 1000, openTime: 0, ...over });

// 約定・TP/SL判定の仕様（ADR 002）: 同一足でTPとSLの両方に触れたら不利な方（SL）を優先する
describe('processOrderRange: TP/SL', () => {
  it('BUY: 同一足でTP/SL両方に触れたらSL決済', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 103, 97, 100)];
    const r = processOrderRange(candles, 0, 1, [pos({ tp: 102, sl: 98 })], [], [], 1_000_000, 2);
    expect(r.positions).toHaveLength(0);
    expect(r.closedTrades).toHaveLength(1);
    expect(r.closedTrades[0].closePrice).toBe(98);
    expect(r.closedTrades[0].pnl).toBeCloseTo(-2000);
    expect(r.balance).toBeCloseTo(998_000);
    expect(r.changed).toBe(true);
  });

  it('SELL: 同一足でTP/SL両方に触れたらSL決済（損失）', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 103, 97, 100)];
    const r = processOrderRange(candles, 0, 1, [pos({ side: 'SELL', tp: 98, sl: 102 })], [], [], 1_000_000, 2);
    expect(r.closedTrades[0].closePrice).toBe(102);
    expect(r.closedTrades[0].pnl).toBeCloseTo(-2000);
  });

  it('BUY: TPだけに触れたらTP決済（利益）', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 103, 99.5, 102)];
    const r = processOrderRange(candles, 0, 1, [pos({ tp: 102, sl: 98 })], [], [], 0, 2);
    expect(r.closedTrades[0].closePrice).toBe(102);
    expect(r.closedTrades[0].pnl).toBeCloseTo(2000);
  });

  it('fromIdxの足は判定対象外（その次の足から見る）', () => {
    const candles = [bar(0, 100, 110, 90, 100), bar(60, 100, 101, 99, 100)];
    const r = processOrderRange(candles, 0, 1, [pos({ tp: 105, sl: 95 })], [], [], 0, 2);
    expect(r.positions).toHaveLength(1);
    expect(r.changed).toBe(false);
  });

  it('決済済み取引へ発注時のR:R画像を引き継ぐ', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 103, 99.5, 102)];
    const r = processOrderRange(candles, 0, 1, [pos({ tp: 102, rrImage: 'data:image/webp;base64,AAA' })], [], [], 0, 2);
    expect(r.closedTrades[0].rrImage).toBe('data:image/webp;base64,AAA');
  });
});

describe('processOrderRange: 指値・逆指値の約定', () => {
  const order = (over: Partial<PendingOrder>): PendingOrder => ({ id: 1, side: 'BUY', type: 'limit', price: 99, lots: 1000, ...over });

  it('足の高値〜安値の範囲に価格が入れば、注文価格・その足の時刻で建玉になる', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 101, 98.5, 100)];
    const r = processOrderRange(candles, 0, 1, [], [order({})], [], 0, 7);
    expect(r.pendingOrders).toHaveLength(0);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ id: 7, openPrice: 99, openTime: 60, side: 'BUY' });
    expect(r.nextId).toBe(8);
  });

  it('範囲に入らなければ未約定のまま', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 101, 99.5, 100)];
    const r = processOrderRange(candles, 0, 1, [], [order({})], [], 0, 7);
    expect(r.pendingOrders).toHaveLength(1);
    expect(r.positions).toHaveLength(0);
    expect(r.changed).toBe(false);
  });

  it('約定した注文のR:R画像は建玉へ引き継ぐ', () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(60, 100, 101, 98.5, 100)];
    const r = processOrderRange(candles, 0, 1, [], [order({ rrImage: 'img' })], [], 0, 7);
    expect(r.positions[0].rrImage).toBe('img');
  });
});
