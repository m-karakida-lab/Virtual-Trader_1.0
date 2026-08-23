import type { Candle } from '../types';

// 月曜 00:00 UTC（その時刻が属する週の開始）
function mondayOfWeekUTC(sec: number): number {
  const d = new Date(sec * 1000);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday) / 1000);
}

// 週替わり（月曜の週 → 別の週）を跨いだ最初の足の時刻を境界として使う。
// JST変換で4H/1D足の時刻が正時からずれるため、計算上の「月曜0時ちょうど」を使うと
// どの足の時刻とも一致せず timeToCoordinate が null を返してしまう（実データ駆動にして回避）
export function computeWeekBoundaries(candles: Candle[]): number[] {
  const boundaries: number[] = [];
  let currentMonday = -1;
  for (const c of candles) {
    const monday = mondayOfWeekUTC(c.time);
    if (monday !== currentMonday) {
      currentMonday = monday;
      boundaries.push(c.time);
    }
  }
  return boundaries;
}
