// 取引履歴の「リスクとパフォーマンス指標」計算。closedTradesとinitialBalanceから純粋関数で
// 算出する（UI側はこの結果を表示するだけ）。
//
// 「レストレーションファクター」「リライアビリティファクター」は一般的な指標名ではなく
// 定まった定義が見つからなかったため、ユーザーへ確認の上で以下の定義で実装している：
//   レストレーションファクター = 最大ドローダウン ÷ 純利益（小さいほど損失からの回復が早い）
//   リライアビリティファクター = 勝ちトレード数 ÷ トレード総数（勝率%を比率のまま表したもの）
import type { ClosedTrade } from '../types';
import { MONTH_SEC } from '../types';
import { SESSIONS, sessionKeyAt } from './sessions';

const DAY_SEC = 86400;
const MONTH_DAYS = MONTH_SEC / DAY_SEC; // 平均月長（日）。types.tsのMONTH_SECと基準を揃える

// その時刻が属する日の00:00（UTCゲッターで読む、weekLines.ts/sessions.tsと同じ約束事。
// 足の時刻は既にJST壁時計時刻として保持されているため、これでJST日境界になる）
function dayStartOf(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

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
  maxDailyLossPct: number | null; // 正の値（%、その日の開始残高比）。取引が無ければnull
  profitFactor: number | null;
  returnPct: number | null;

  // トレード数
  totalTrades: number;
  tradingDays: number;
  winCount: number;
  lossCount: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgTradesPerDay: number | null;
  avgTradesPerMonth: number | null;
  avgWinsPerMonth: number | null;
  avgLossesPerMonth: number | null;
  largestWin: number;
  largestLoss: number; // 負の値

  // 時間
  elapsedDays: number;
  elapsedMonths: number;

  // その他
  maxLots: number;
  restorationFactor: number | null;
  reliabilityFactor: number | null;
  winRatePct: number | null;
  lossRatePct: number | null;

  // セッション別分析: エントリー時刻（openTime）でどのセッションだったかを判定して集計。
  // どのセッションにも属さない時間帯（NY終了〜東京開始の2時間）は「セッション外」にまとめる
  bySession: { key: string; label: string; count: number; pnl: number }[];
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
  const hasElapsedMonths = elapsedMonths > 0;
  const hasElapsedDays = elapsedDays > 0;

  const avgMonthlyProfit = hasElapsedMonths ? netProfit / elapsedMonths : netProfit;
  const avgTradesPerMonth = totalTrades > 0 ? (hasElapsedMonths ? totalTrades / elapsedMonths : totalTrades) : null;
  const avgWinsPerMonth = totalTrades > 0 ? (hasElapsedMonths ? winCount / elapsedMonths : winCount) : null;
  const avgLossesPerMonth = totalTrades > 0 ? (hasElapsedMonths ? lossCount / elapsedMonths : lossCount) : null;

  // Trading Days数（決済が発生した日のユニーク数、参考値として別枠で表示）
  const tradingDaySet = new Set(sorted.map(t => dayStartOf(t.closeTime)));
  const tradingDays = tradingDaySet.size;
  // 1日平均トレード数は「月平均トレード数」と同じ経過暦日数（elapsedDays、取引が無かった日も
  // 含む）を分母にする。以前はtradingDays（取引があった日だけ）で割っていたため、月平均を
  // 30で割った値と桁が合わず、取引が特定の日に集中していると平均が不自然に高く出ていた
  const avgTradesPerDay = totalTrades > 0 ? (hasElapsedDays ? totalTrades / elapsedDays : totalTrades) : null;

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

  // 当日最大損失率%: 日ごとの損益を積み上げ、その日の開始残高に対する下落率が最も大きい日を探す
  let dayBal = initialBalance;
  let dayStartBal = initialBalance;
  let curDay: number | null = null;
  let maxDailyLossPct: number | null = null;
  const closeDayEnd = () => {
    if (curDay === null) return;
    const dayPnl = dayBal - dayStartBal;
    if (dayPnl < 0 && dayStartBal > 0) {
      const lossPct = (-dayPnl / dayStartBal) * 100;
      maxDailyLossPct = maxDailyLossPct === null ? lossPct : Math.max(maxDailyLossPct, lossPct);
    }
  };
  for (const t of sorted) {
    const day = dayStartOf(t.closeTime);
    if (curDay === null) { curDay = day; dayStartBal = dayBal; }
    else if (day !== curDay) { closeDayEnd(); curDay = day; dayStartBal = dayBal; }
    dayBal += t.pnl;
  }
  closeDayEnd();

  const restorationFactor = netProfit !== 0 ? maxDrawdown / netProfit : null;
  const reliabilityFactor = totalTrades > 0 ? winCount / totalTrades : null;
  const winRatePct = totalTrades > 0 ? (winCount / totalTrades) * 100 : null;
  const lossRatePct = totalTrades > 0 ? (lossCount / totalTrades) * 100 : null;

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

  return {
    netProfit, avgTradePnl, grossProfit, grossLoss, avgMonthlyProfit, avgWin, avgLoss,
    maxDrawdown, maxDailyLossPct, profitFactor, returnPct,
    totalTrades, tradingDays, winCount, lossCount, maxConsecutiveWins, maxConsecutiveLosses,
    avgTradesPerDay, avgTradesPerMonth, avgWinsPerMonth, avgLossesPerMonth, largestWin, largestLoss,
    elapsedDays, elapsedMonths,
    maxLots, restorationFactor, reliabilityFactor, winRatePct, lossRatePct,
    bySession,
  };
}
