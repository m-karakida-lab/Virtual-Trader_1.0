import type { Candle } from '../types';
import { MONTH_SEC } from '../types';

// その時刻が属する日の 00:00 UTC
function dayOfUTC(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

// その時刻が属する週（月曜始まり、キー比較専用）
function weekKeyOf(sec: number): number {
  const d = new Date(sec * 1000);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday) / 1000);
}

// その時刻が属する月（年*12+月、キー比較専用）
function monthKeyOf(sec: number): number {
  const d = new Date(sec * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

// その時刻が属する年（キー比較専用）
function yearKeyOf(sec: number): number {
  return new Date(sec * 1000).getUTCFullYear();
}

// 区切り替わり（キーが変わる）を跨いだ最初の足の時刻を境界として使う。
// JST変換で4H/1D足の時刻が正時からずれるため、計算上の「0時ちょうど」を使うと
// どの足の時刻とも一致せず timeToCoordinate が null を返してしまう（実データ駆動にして回避）
function computeBoundaries(candles: Candle[], keyOf: (sec: number) => number): number[] {
  const boundaries: number[] = [];
  let currentKey = -1;
  for (const c of candles) {
    const key = keyOf(c.time);
    if (key !== currentKey) {
      currentKey = key;
      boundaries.push(c.time);
    }
  }
  return boundaries;
}

export function computeDayBoundaries(candles: Candle[]): number[] {
  return computeBoundaries(candles, dayOfUTC);
}

export function computeWeekBoundaries(candles: Candle[]): number[] {
  return computeBoundaries(candles, weekKeyOf);
}

export function computeMonthBoundaries(candles: Candle[]): number[] {
  return computeBoundaries(candles, monthKeyOf);
}

export function computeYearBoundaries(candles: Candle[]): number[] {
  return computeBoundaries(candles, yearKeyOf);
}

// 区切り線の周期は時間軸によって切り替える:
// MN足=年区切り、1D/1W足=月区切り、4H足=週区切り、それ以外（15m/1H）は日区切り
export function computeSeparatorBoundaries(candles: Candle[], timeframeSec: number): number[] {
  if (timeframeSec === MONTH_SEC) return computeYearBoundaries(candles);
  if (timeframeSec >= 86400) return computeMonthBoundaries(candles);
  if (timeframeSec === 14400) return computeWeekBoundaries(candles);
  return computeDayBoundaries(candles);
}
