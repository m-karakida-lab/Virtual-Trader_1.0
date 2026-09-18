import type { Candle } from '../types';

// 東京/ロンドン/NYの大まかな取引時間帯（JST基準、サマータイム等の年内変動は考慮しない簡易版）。
// 足の時刻は既にJST壁時計時刻として保持されている前提（weekLines.tsと同じ約束事）。
// 3セッションが重ならないよう境界を揃えてある（東京9-17時、ロンドン17-22時、NY22-7時）
export const SESSIONS = [
  { key: 'asia',   label: '東京',     color: 'rgba(255,193,7,0.06)',  startHour: 9,  endHour: 17 },
  { key: 'london', label: 'ロンドン', color: 'rgba(76,175,80,0.06)',  startHour: 17, endHour: 22 },
  { key: 'ny',     label: 'NY',       color: 'rgba(33,150,243,0.06)', startHour: 22, endHour: 31 },
] as const;

export interface SessionBand {
  key: typeof SESSIONS[number]['key'];
  start: number;
  end: number;
}

// その時刻が属する日の本当の00:00（UTC相当のゲッターで読む、weekLines.tsのdayOfUTCと同じ約束事）。
// weekLines.ts の computeDayBoundaries は「その日の最初の足の時刻」を境界に使っており
// （区切り線1本引ければ十分なため、多少ズレても問題にならない）、週明け等で最初の足が
// 00:00ちょうどでない日があると、そこから足すセッション時刻（9/17/22時）まで丸ごとズレて
// しまう（週末明けの月曜だけ帯の位置がおかしく見える不具合として実際に発覚）。
// セッション帯は正確な時刻が要るため、本当の日付境界を自前で計算する
function dayStartOf(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

// 実データに存在する日ごとに3セッション分の帯を作る（足が1本も無い日には帯を作らない）
export function computeSessionBands(candles: Candle[]): SessionBand[] {
  const days: number[] = [];
  let prevDay = -1;
  for (const c of candles) {
    const day = dayStartOf(c.time);
    if (day !== prevDay) {
      days.push(day);
      prevDay = day;
    }
  }
  const bands: SessionBand[] = [];
  for (const dayStart of days) {
    for (const s of SESSIONS) {
      bands.push({ key: s.key, start: dayStart + s.startHour * 3600, end: dayStart + s.endHour * 3600 });
    }
  }
  return bands;
}
