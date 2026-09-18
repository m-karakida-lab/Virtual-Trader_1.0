import type { Candle } from '../types';
import { computeDayBoundaries } from './weekLines';

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

// 実データに存在する日ごとに3セッション分の帯を作る（weekLines.tsのcomputeDayBoundariesを
// 流用し、実足に存在しない日には帯を作らない）
export function computeSessionBands(candles: Candle[]): SessionBand[] {
  const days = computeDayBoundaries(candles);
  const bands: SessionBand[] = [];
  for (const dayStart of days) {
    for (const s of SESSIONS) {
      bands.push({ key: s.key, start: dayStart + s.startHour * 3600, end: dayStart + s.endHour * 3600 });
    }
  }
  return bands;
}
