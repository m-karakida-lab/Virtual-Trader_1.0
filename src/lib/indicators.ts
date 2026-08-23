// インジケーター（EMA・ボリンジャーバンド・一目均衡表の雲）の計算ロジック。
// CandleChart（メインパネル）は増分計算の最適化版を別途持つが、MiniChartは
// 表示更新のたびに全期間を再計算しても軽いため、こちらの単純な全体計算版を使う。
import type { Time, LineData } from 'lightweight-charts';
import type { Candle } from '../types';

export const EMA_PERIOD = 200;
export const BB_PERIOD = 20;
export const TENKAN_PERIOD = 9;
export const KIJUN_PERIOD = 26;
export const SENKOU_B_PERIOD = 52;
export const CLOUD_SHIFT = 26;

export function computeEMA(candles: Candle[]): LineData[] {
  const k = 2 / (EMA_PERIOD + 1);
  let sum = 0;
  let ema = 0;
  const data: LineData[] = [];
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    if (i < EMA_PERIOD - 1) { sum += close; continue; }
    if (i === EMA_PERIOD - 1) { sum += close; ema = sum / EMA_PERIOD; }
    else { ema = close * k + ema * (1 - k); }
    data.push({ time: candles[i].time as Time, value: ema });
  }
  return data;
}

function highLowWindow(cs: Candle[], idx: number, period: number): { hi: number; lo: number } {
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, idx - period + 1); j <= idx; j++) {
    if (cs[j].high > hi) hi = cs[j].high;
    if (cs[j].low  < lo) lo = cs[j].low;
  }
  return { hi, lo };
}

export interface BBSeries {
  basis: LineData[]; upper1: LineData[]; lower1: LineData[]; upper2: LineData[]; lower2: LineData[];
}

export function computeBB(candles: Candle[]): BBSeries {
  const basis: LineData[] = [], upper1: LineData[] = [], lower1: LineData[] = [], upper2: LineData[] = [], lower2: LineData[] = [];
  let sum = 0, sumSq = 0;
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    sum += close;
    sumSq += close * close;
    if (i >= BB_PERIOD) {
      const old = candles[i - BB_PERIOD].close;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= BB_PERIOD - 1) {
      const mean = sum / BB_PERIOD;
      const sd = Math.sqrt(Math.max(sumSq / BB_PERIOD - mean * mean, 0));
      const time = candles[i].time as Time;
      basis.push({ time, value: mean });
      upper1.push({ time, value: mean + sd });
      lower1.push({ time, value: mean - sd });
      upper2.push({ time, value: mean + 2 * sd });
      lower2.push({ time, value: mean - 2 * sd });
    }
  }
  return { basis, upper1, lower1, upper2, lower2 };
}

function computeCloudPoint(cs: Candle[], idx: number): { a: number; b: number } | null {
  if (idx < SENKOU_B_PERIOD - 1) return null;
  const tenkanW  = highLowWindow(cs, idx, TENKAN_PERIOD);
  const kijunW   = highLowWindow(cs, idx, KIJUN_PERIOD);
  const senkouBW = highLowWindow(cs, idx, SENKOU_B_PERIOD);
  const tenkan = (tenkanW.hi + tenkanW.lo) / 2;
  const kijun  = (kijunW.hi + kijunW.lo) / 2;
  return { a: (tenkan + kijun) / 2, b: (senkouBW.hi + senkouBW.lo) / 2 };
}

export interface CloudSeries {
  senkouA: LineData[];
  senkouB: LineData[];
  points: { time: number; a: number; b: number }[]; // canvas塗りつぶし用
}

// timeframeSec: 先行スパンを CLOUD_SHIFT 本先の時刻にずらすための足の間隔（秒）
export function computeCloud(candles: Candle[], timeframeSec: number): CloudSeries {
  const senkouA: LineData[] = [];
  const senkouB: LineData[] = [];
  const points: { time: number; a: number; b: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const pt = computeCloudPoint(candles, i);
    if (!pt) continue;
    const displaced = candles[i].time + CLOUD_SHIFT * timeframeSec;
    senkouA.push({ time: displaced as Time, value: pt.a });
    senkouB.push({ time: displaced as Time, value: pt.b });
    points.push({ time: displaced, a: pt.a, b: pt.b });
  }
  return { senkouA, senkouB, points };
}
