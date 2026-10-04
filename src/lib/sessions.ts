import type { Candle } from '../types';

// 東京/ロンドン/NYの大まかな取引時間帯（JST基準、サマータイム等の年内変動は考慮しない簡易版）。
// 足の時刻は既にJST壁時計時刻として保持されている前提（weekLines.tsと同じ約束事）。
// 3セッションが重ならないよう境界を揃えてある（東京9-16時、ロンドン16-22時、NY22-7時）。
// セッション帯はチャート下部の1行の濃い色帯で描く（全面の薄い背景帯は見づらいため）
export const SESSIONS = [
  { key: 'asia',   label: '東京',     color: '#ffb300', startHour: 9,  endHour: 16 },
  { key: 'london', label: 'ロンドン', color: '#43a047', startHour: 16, endHour: 22 },
  { key: 'ny',     label: 'NY',       color: '#1e88e5', startHour: 22, endHour: 31 },
] as const;

export interface SessionBand {
  key: typeof SESSIONS[number]['key'];
  start: number;
  end: number;
}

// その時刻が属する日の本当の00:00（UTC相当のゲッターで読む、weekLines.tsのdayOfUTCと同じ約束事）。
// weekLines.ts の computeDayBoundaries は「その日の最初の足の時刻」を境界に使うため、
// 週明け等で最初の足が00:00ちょうどでない日は、そこから足すセッション時刻（9/17/22時）まで
// ズレる。セッション帯は正確な時刻が要るので、本当の日付境界を自前で計算する
function dayStartOf(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

// その時刻がどのセッションに属するか（時間帯のみで判定、日付は問わない）。
// NY終了(7時)〜東京開始(9時)の2時間はどのセッションにも属さないためnullを返す
// （取引履歴のセッション別分析で使う。sessions.ts自身のチャート表示ロジックとは独立）
export function sessionKeyAt(sec: number): typeof SESSIONS[number]['key'] | null {
  const d = new Date(sec * 1000);
  const hour = d.getUTCHours();
  for (const s of SESSIONS) {
    const endHour = s.endHour % 24;
    const wraps = s.endHour > 24;
    if (wraps ? (hour >= s.startHour || hour < endHour) : (hour >= s.startHour && hour < endHour)) {
      return s.key;
    }
  }
  return null;
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
