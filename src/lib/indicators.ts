// インジケーター（EMA・ボリンジャーバンド・一目均衡表の雲）の計算ロジック。
// CandleChart（メインパネル）は増分計算の最適化版を別途持つが、MiniChartは
// 表示更新のたびに全期間を再計算しても軽いため、こちらの単純な全体計算版を使う。
import type { Time, LineData } from 'lightweight-charts';
import type { Candle } from '../types';

export const EMA_PERIOD = 200;
export const SMA_PERIOD = 14;
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

export function computeSMA(candles: Candle[]): LineData[] {
  const data: LineData[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= SMA_PERIOD) sum -= candles[i - SMA_PERIOD].close;
    if (i >= SMA_PERIOD - 1) data.push({ time: candles[i].time as Time, value: sum / SMA_PERIOD });
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

// 先行スパンを置く時刻。「26本先」は必ず"本数"で数える（時刻に 26*timeframeSec 秒を足さない）。
// lightweight-charts は足を時刻ではなくインデックスで並べ、時間軸の目盛りはそのチャートに
// 載っている全シリーズの時刻の和集合になる。そのため雲がローソク足に存在しない時刻
// （週末・DSTでずれた時刻・MN足の平均月秒など）を持ち込むと、その時刻のぶんだけ空スロットが
// 増え、週またぎで足が途切れて見える（visible:false のシリーズも時刻は残るのでOFFでも消えない）。
// データ終端より先だけは実在する足が無いため最終足からの等間隔で合成する。これは全ローソク足より
// 右にしか出ないので途中に隙間を作ることはない。実在の足があるときに外挿してはいけない
// （後から足が埋まると、外挿した時刻が中間に取り残されて同じ不具合が再発する）
export function cloudDisplacedTime(cs: Candle[], i: number, timeframeSec: number): number {
  const j = i + CLOUD_SHIFT;
  if (j < cs.length) return cs[j].time;
  const last = cs.length - 1;
  return cs[last].time + (j - last) * timeframeSec;
}

// candles:    描画する範囲（MiniChartはカーソルまでに切り詰めた前方部分列）
// timeframeSec: データ終端より先を合成するための足の間隔（秒）
// allCandles: ずらし先の時刻を引くための全期間データ。candles はこの配列の先頭からの部分列であること。
//             値は candles からしか読まない（時刻だけ参照するので未来の価格は覗いていない）
export function computeCloud(candles: Candle[], timeframeSec: number, allCandles: Candle[]): CloudSeries {
  const senkouA: LineData[] = [];
  const senkouB: LineData[] = [];
  const points: { time: number; a: number; b: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const pt = computeCloudPoint(candles, i);
    if (!pt) continue;
    const displaced = cloudDisplacedTime(allCandles, i, timeframeSec);
    senkouA.push({ time: displaced as Time, value: pt.a });
    senkouB.push({ time: displaced as Time, value: pt.b });
    points.push({ time: displaced, a: pt.a, b: pt.b });
  }
  return { senkouA, senkouB, points };
}
