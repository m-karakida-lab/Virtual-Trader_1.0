// 取引履歴の「リスクとパフォーマンス指標」計算。closedTradesとinitialBalanceから純粋関数で
// 算出する（UI側はこの結果を表示するだけ）。
import type { ClosedTrade } from '../types';
import { MONTH_SEC, WEEK_SEC } from '../types';
import { SESSIONS, sessionKeyAt } from './sessions';

const DAY_SEC = 86400;
const MONTH_DAYS = MONTH_SEC / DAY_SEC; // 平均月長（日）。types.tsのMONTH_SECと基準を揃える
const WEEK_DAYS = WEEK_SEC / DAY_SEC;

// エントリー曜日別分析用。月〜金の5区分のみ（FXは土日がほぼ休場で日足も5本/週）。
// openTimeは既にJST変換済み前提（getUTCDay基準、プロジェクト全体の慣例に合わせる）。
// 週明け/週末クローズ間際でgetUTCDayが日曜(0)・土曜(6)にずれ込むごく稀なケースは、
// それぞれ直後の月曜・直前の金曜にまとめる（休場日の列を作らないため）
const WEEKDAY_LABELS = ['月', '火', '水', '木', '金'];
function weekdayBucketIndex(day: number): number {
  if (day === 0) return 0; // 日曜→月曜
  if (day === 6) return 4; // 土曜→金曜
  return day - 1;
}

// 保有期間帯（デイトレ〜スイングを想定した区切り。スキャルは対象外の想定なので分未満は作らない）
const HOLD_BUCKETS: { key: string; label: string; maxSec: number }[] = [
  { key: 'lt1h', label: '1時間未満', maxSec: 3600 },
  { key: '1-4h', label: '1〜4時間', maxSec: 4 * 3600 },
  { key: '4-24h', label: '4〜24時間', maxSec: DAY_SEC },
  { key: '1-3d', label: '1〜3日', maxSec: 3 * DAY_SEC },
  { key: '3-7d', label: '3〜7日', maxSec: WEEK_SEC },
  { key: 'gte7d', label: '7日以上', maxSec: Infinity },
];

export interface TradeStats {
  // 収入
  netProfit: number;
  avgTradePnl: number;
  grossProfit: number;
  grossLoss: number; // 負の値
  avgMonthlyProfit: number;
  avgWin: number;
  avgLoss: number; // 負の値
  maxDrawdown: number; // 正の値（下落幅）
  profitFactor: number | null;
  returnPct: number | null;

  // トレード数
  totalTrades: number;
  winCount: number;
  lossCount: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgTradesPerWeek: number | null;
  avgTradesPerMonth: number | null;
  avgWinsPerMonth: number | null;
  avgLossesPerMonth: number | null;
  largestWin: number;
  largestLoss: number; // 負の値

  // 時間
  elapsedDays: number;
  elapsedMonths: number;
  avgHoldSec: number | null;
  avgHoldWinSec: number | null;
  avgHoldLossSec: number | null;

  // その他
  maxLots: number;
  winRatePct: number | null;
  lossRatePct: number | null;

  // セッション別分析: エントリー時刻（openTime）でどのセッションだったかを判定して集計。
  // どのセッションにも属さない時間帯（NY終了〜東京開始の2時間）は「セッション外」にまとめる
  bySession: { key: string; label: string; count: number; pnl: number }[];

  // 曜日別分析: エントリー曜日（openTime基準）ごとの件数・損益
  byWeekday: { key: string; label: string; count: number; pnl: number }[];

  // 保有期間帯別分析: デイトレ〜スイングのどの帯で取引しているか・その帯の勝率感を掴む用
  byHoldBucket: { key: string; label: string; count: number; pnl: number }[];
}

export function computeTradeStats(trades: ClosedTrade[], initialBalance: number): TradeStats {
  const totalTrades = trades.length;
  const sorted = [...trades].sort((a, b) => a.closeTime - b.closeTime);

  const wins = sorted.filter(t => t.pnl > 0);
  const losses = sorted.filter(t => t.pnl < 0);
  const winCount = wins.length;
  const lossCount = losses.length;

  const netProfit = sorted.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0); // 負の値

  const avgTradePnl = totalTrades > 0 ? netProfit / totalTrades : 0;
  const avgWin = winCount > 0 ? grossProfit / winCount : 0;
  const avgLoss = lossCount > 0 ? grossLoss / lossCount : 0;
  const largestWin = winCount > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
  const largestLoss = lossCount > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;
  const maxLots = totalTrades > 0 ? Math.max(...sorted.map(t => t.lots)) : 0;

  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;
  const returnPct = initialBalance > 0 ? (netProfit / initialBalance) * 100 : null;

  // 経過期間: 最初の建玉〜最後の決済まで
  const elapsedDays = totalTrades > 0
    ? Math.max(0, (sorted[sorted.length - 1].closeTime - Math.min(...sorted.map(t => t.openTime))) / DAY_SEC)
    : 0;
  const elapsedMonths = elapsedDays / MONTH_DAYS;
  const elapsedWeeks = elapsedDays / WEEK_DAYS;
  const hasElapsedMonths = elapsedMonths > 0;
  const hasElapsedWeeks = elapsedWeeks > 0;

  const avgMonthlyProfit = hasElapsedMonths ? netProfit / elapsedMonths : netProfit;
  const avgTradesPerMonth = totalTrades > 0 ? (hasElapsedMonths ? totalTrades / elapsedMonths : totalTrades) : null;
  const avgWinsPerMonth = totalTrades > 0 ? (hasElapsedMonths ? winCount / elapsedMonths : winCount) : null;
  const avgLossesPerMonth = totalTrades > 0 ? (hasElapsedMonths ? lossCount / elapsedMonths : lossCount) : null;
  // 週平均トレード数は月平均と同じ考え方（経過暦日数を7で割った週数を分母にする）
  const avgTradesPerWeek = totalTrades > 0 ? (hasElapsedWeeks ? totalTrades / elapsedWeeks : totalTrades) : null;

  // 最大連続勝ち/負け（決済順、pnl===0は連続をリセットする＝勝ちにも負けにも数えない）
  let maxConsecutiveWins = 0, maxConsecutiveLosses = 0, curWin = 0, curLoss = 0;
  for (const t of sorted) {
    if (t.pnl > 0) { curWin++; curLoss = 0; }
    else if (t.pnl < 0) { curLoss++; curWin = 0; }
    else { curWin = 0; curLoss = 0; }
    maxConsecutiveWins = Math.max(maxConsecutiveWins, curWin);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, curLoss);
  }

  // エクイティカーブから最大ドローダウンを算出（HistoryPanel.tsxの線グラフと同じ積み上げ方）
  let bal = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  for (const t of sorted) {
    bal += t.pnl;
    peak = Math.max(peak, bal);
    maxDrawdown = Math.max(maxDrawdown, peak - bal);
  }

  const winRatePct = totalTrades > 0 ? (winCount / totalTrades) * 100 : null;
  const lossRatePct = totalTrades > 0 ? (lossCount / totalTrades) * 100 : null;

  // 保有期間（決済-建玉）。勝ち/負けで平均が大きく違う場合、「勝ちを伸ばせず負けを長引かせて
  // いないか」等の気づきに繋がる想定
  const holdSecs = sorted.map(t => t.closeTime - t.openTime);
  const avgHoldSec = totalTrades > 0 ? holdSecs.reduce((s, v) => s + v, 0) / totalTrades : null;
  const winHoldSecs = wins.map(t => t.closeTime - t.openTime);
  const lossHoldSecs = losses.map(t => t.closeTime - t.openTime);
  const avgHoldWinSec = winCount > 0 ? winHoldSecs.reduce((s, v) => s + v, 0) / winCount : null;
  const avgHoldLossSec = lossCount > 0 ? lossHoldSecs.reduce((s, v) => s + v, 0) / lossCount : null;

  const sessionBuckets = new Map<string, { key: string; label: string; count: number; pnl: number }>();
  for (const s of SESSIONS) sessionBuckets.set(s.key, { key: s.key, label: s.label, count: 0, pnl: 0 });
  sessionBuckets.set('other', { key: 'other', label: 'セッション外', count: 0, pnl: 0 });
  for (const t of sorted) {
    const key = sessionKeyAt(t.openTime) ?? 'other';
    const bucket = sessionBuckets.get(key)!;
    bucket.count++;
    bucket.pnl += t.pnl;
  }
  const bySession = [...sessionBuckets.values()];

  // openTimeは既にJST変換済み前提（プロジェクト全体の慣例。fmtDateTime等と同じgetUTCDay基準）
  const weekdayBuckets = WEEKDAY_LABELS.map((label, i) => ({ key: String(i), label: `${label}曜`, count: 0, pnl: 0 }));
  for (const t of sorted) {
    const bucket = weekdayBuckets[weekdayBucketIndex(new Date(t.openTime * 1000).getUTCDay())];
    bucket.count++;
    bucket.pnl += t.pnl;
  }
  const byWeekday = weekdayBuckets;

  const holdBuckets = HOLD_BUCKETS.map(b => ({ key: b.key, label: b.label, count: 0, pnl: 0 }));
  for (const t of sorted) {
    const sec = t.closeTime - t.openTime;
    const idx = HOLD_BUCKETS.findIndex(b => sec < b.maxSec);
    const bucket = holdBuckets[idx === -1 ? holdBuckets.length - 1 : idx];
    bucket.count++;
    bucket.pnl += t.pnl;
  }
  const byHoldBucket = holdBuckets;

  return {
    netProfit, avgTradePnl, grossProfit, grossLoss, avgMonthlyProfit, avgWin, avgLoss,
    maxDrawdown, profitFactor, returnPct,
    totalTrades, winCount, lossCount, maxConsecutiveWins, maxConsecutiveLosses,
    avgTradesPerWeek, avgTradesPerMonth, avgWinsPerMonth, avgLossesPerMonth, largestWin, largestLoss,
    elapsedDays, elapsedMonths, avgHoldSec, avgHoldWinSec, avgHoldLossSec,
    maxLots, winRatePct, lossRatePct,
    bySession, byWeekday, byHoldBucket,
  };
}
