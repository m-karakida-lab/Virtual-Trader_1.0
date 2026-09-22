// 取引履歴を外部のAI（ChatGPT/Claude等）に読み込ませて分析してもらうためのMarkdown出力。
// このアプリ自体にAIを組み込むのではなく、テキストファイルとして書き出して外部に渡す想定
// （プライバシー・実装コストの両面でその方が「わがまま自作ツール」の方針に合う）。
// このアプリを知らないAIでもいきなり正しく読めるよう、冒頭に用語・前提の説明を必ず含める。
import type { ClosedTrade } from '../types';
import { computeTradeStats } from './tradeStats';
import { inferPipSize, pricePrecision } from './pips';
import { summarizeExcursions, type TradeExcursion } from './tradeExcursion';

function fmtDateTimeFull(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtDurationFull(sec: number): string {
  const totalMin = Math.round(sec / 60);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分`);
  return parts.join('');
}

function tradePips(t: ClosedTrade): number {
  const dir = t.side === 'BUY' ? 1 : -1;
  return ((t.closePrice - t.openPrice) * dir) / inferPipSize(t.openPrice);
}

const nn = (v: number | null, f: (v: number) => string) => v === null ? 'なし' : f(v);
const money = (sym: string, n: number) => `${n >= 0 ? '+' : ''}${sym}${Math.round(n).toLocaleString('ja-JP')}`;

export function buildAiAnalysisMarkdown(params: {
  closedTrades: ClosedTrade[];
  initialBalance: number;
  balance: number;
  quoteCurrency: string;
  symbol: string;
  sym: string; // 通貨記号（¥ $ 等）
  excursions: Map<number, TradeExcursion> | null; // MAE/MFE・損切り後の値動き（1分足から事後計算。集計中はnull）
}): string {
  const { closedTrades, initialBalance, balance, quoteCurrency, symbol, sym, excursions } = params;
  const sorted = [...closedTrades].sort((a, b) => a.closeTime - b.closeTime);
  const rs = computeTradeStats(closedTrades, initialBalance);
  const exSummary = excursions ? summarizeExcursions(closedTrades, excursions) : null;
  const now = new Date();

  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('# FXバックテスト取引履歴 分析用データ');
  p('');
  p(`出力日時: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  p('');

  p('## このファイルについて（AI向けの取説）');
  p('');
  p('このファイルは、個人用のFXバックテスト/リプレイ検証ツール「Virtual Trader」から書き出した、');
  p('過去の値動きを使ったシミュレーション取引（バックテスト）の履歴です。実弾の取引ではありません。');
  p('このツールを一切知らない前提で、以下を踏まえて分析・アドバイスをしてください。');
  p('');
  p('- **トレードスタイル**: デイトレード〜スイングトレードを想定（数分足でのスキャルピングは行わない）');
  p('- **取引頻度**: 週に数回程度を想定した検証');
  p('- **通貨ペア**: ' + (symbol || '不明') + `（クオート通貨: ${quoteCurrency}）`);
  p('- **pips**: JPYクロスは1pip=0.01、それ以外は1pip=0.0001（フラクショナルピップ込み）で計算');
  p('- **ロット**: 通貨量そのもの（例: 1,000 = 1,000通貨）。ロット間で通貨量の単位は揃っている');
  p('- **セッション区分**: 東京9-16時/ロンドン16-22時/NY22-翌7時（すべて日本時間、重複なしで按分）。どれにも該当しない時間帯は「セッション外」');
  p('- **曜日別分析**: エントリー曜日（日本時間）を月〜金の5区分に集計（FXは土日ほぼ休場のため。週跨ぎで極稀に土/日にずれた分は直前の金曜/直後の月曜に合算済み）');
  p('- **保有期間帯別分析**: 決済時刻-建玉時刻の長さを「1時間未満/1〜4時間/4〜24時間/1〜3日/3〜7日/7日以上」の6区分に分類');
  p('- **MAE（最大逆行幅）/MFE（最大順行幅）**: 保有中に最大で何pips含み損／含み益になったか（1分足まで遡って事後計算）。SL幅の妥当性やエントリータイミングの検証に使えます');
  p('- **損切り後の値動き（post12hFav/post24hFav/post24hAdv）**: 決済後12時間・24時間以内に、エントリー方向へ最大何pips戻ったか（fav）／さらに逆行したか（adv）。バックテストなので決済後の未来データも既に判明しており、これは実際の値動きです（推測ではありません）');
  p('- **重要な注意**: MAE/MFE・損切り後の値動きは「あくまで結果論（ヒンドサイト）」です。当時はその後の値動きを知り得なかったため、「次から損切りせず握り続けるべき」という短絡的な結論は出さないでください。あくまで「SL幅が狭すぎないか」「エントリーの精度」等の検証材料として扱ってください');
  p('- **このデータに含まれないもの**: エントリー/決済の根拠・当時のニュースやチャート形状・注文時の感情などの定性的な情報は一切記録されていません。あくまで価格と時刻の数値だけから読み取れる傾向を指摘してください');
  p('- **見てほしい観点の例**: 勝率とPFのバランス、曜日や保有期間による成績の偏り、連敗の起きやすさ、含み損を伸ばしていないか（負けトレードの平均保有期間が勝ちより極端に長い等）、ロング/ショートの偏り、セッションごとの得意不得意');
  p('');

  p('## 口座サマリー');
  p('');
  p(`- 初期残高: ${sym}${Math.round(initialBalance).toLocaleString('ja-JP')}`);
  p(`- 現在残高: ${sym}${Math.round(balance).toLocaleString('ja-JP')}`);
  p(`- 総取引数: ${rs.totalTrades}（勝ち ${rs.winCount} / 負け ${rs.lossCount}）`);
  p('');

  p('## 集計指標');
  p('');
  p('### 収入');
  p(`- 純利益: ${money(sym, rs.netProfit)}`);
  p(`- 平均トレード損益: ${money(sym, rs.avgTradePnl)}`);
  p(`- 利益総計 / 損失総計: ${sym}${Math.round(rs.grossProfit).toLocaleString('ja-JP')} / ${sym}${Math.round(Math.abs(rs.grossLoss)).toLocaleString('ja-JP')}`);
  p(`- 月平均利益: ${money(sym, rs.avgMonthlyProfit)}`);
  p(`- 利益平均額 / 損失平均額: ${sym}${Math.round(rs.avgWin).toLocaleString('ja-JP')} / ${sym}${Math.round(Math.abs(rs.avgLoss)).toLocaleString('ja-JP')}`);
  p(`- 最大ドローダウン: ${sym}${Math.round(rs.maxDrawdown).toLocaleString('ja-JP')}`);
  p(`- プロフィットファクター: ${nn(rs.profitFactor, v => v.toFixed(2))}`);
  p(`- リターン: ${nn(rs.returnPct, v => v.toFixed(1) + '%')}`);
  p('');
  p('### トレード数・頻度');
  p(`- 最大連続利益 / 最大連続損失: ${rs.maxConsecutiveWins}連勝 / ${rs.maxConsecutiveLosses}連敗`);
  p(`- 週平均トレード数: ${nn(rs.avgTradesPerWeek, v => v.toFixed(1))}`);
  p(`- 月平均トレード数: ${nn(rs.avgTradesPerMonth, v => v.toFixed(1))}`);
  p(`- 1トレードの最大利益 / 最大損失: ${sym}${Math.round(rs.largestWin).toLocaleString('ja-JP')} / ${sym}${Math.round(Math.abs(rs.largestLoss)).toLocaleString('ja-JP')}`);
  p(`- 勝率 / 損失率: ${nn(rs.winRatePct, v => v.toFixed(1) + '%')} / ${nn(rs.lossRatePct, v => v.toFixed(1) + '%')}`);
  p('');
  p('### 保有期間');
  p(`- 経過日数 / 経過月数: ${rs.elapsedDays.toFixed(1)}日 / ${rs.elapsedMonths.toFixed(1)}ヶ月`);
  p(`- 平均保有期間（全体）: ${nn(rs.avgHoldSec, fmtDurationFull)}`);
  p(`- 平均保有期間（勝ちトレード）: ${nn(rs.avgHoldWinSec, fmtDurationFull)}`);
  p(`- 平均保有期間（負けトレード）: ${nn(rs.avgHoldLossSec, fmtDurationFull)}`);
  p('');

  p('## セッション別（東京/ロンドン/NY/セッション外）');
  p('');
  p('| セッション | 件数 | 損益 |');
  p('|---|---|---|');
  for (const s of rs.bySession) p(`| ${s.label} | ${s.count} | ${money(sym, s.pnl)} |`);
  p('');

  p('## 曜日別（エントリー曜日、月〜金）');
  p('');
  p('| 曜日 | 件数 | 損益 |');
  p('|---|---|---|');
  for (const w of rs.byWeekday) p(`| ${w.label} | ${w.count} | ${money(sym, w.pnl)} |`);
  p('');

  p('## 保有期間帯別');
  p('');
  p('| 保有期間帯 | 件数 | 損益 |');
  p('|---|---|---|');
  for (const b of rs.byHoldBucket) p(`| ${b.label} | ${b.count} | ${money(sym, b.pnl)} |`);
  p('');

  if (exSummary) {
    p('## 保有中の振れ幅・損切り後の値動き');
    p('');
    p(`- 平均MAE（最大含み損）: ${nn(exSummary.avgMaePips, v => v.toFixed(1) + 'pips')}`);
    p(`- 平均MFE（最大含み益）: ${nn(exSummary.avgMfePips, v => v.toFixed(1) + 'pips')}`);
    p(`- 負けトレードの損切り後24h以内の平均の戻り幅: ${nn(exSummary.avgPostCloseFavPipsForLosses, v => v.toFixed(1) + 'pips')}`);
    p(`- 負けトレードのうち損切り後24h以内に建値以上まで戻った割合: ${nn(exSummary.recoveredWithin24hPct, v => v.toFixed(0) + '%')}`);
    p('');
  }

  p('## 取引一覧（全件、決済時刻の昇順）');
  p('');
  p('日時は日本時間。「pips」はBUY/SELLの方向を考慮した符号付きの値幅です。');
  p('MAE/MFEは保有中、post12hFav/post24hFav/post24hAdvは決済後の値幅（列の説明は冒頭の取説を参照）。');
  p('');
  const exCols = excursions ? ' MAE | MFE | post12hFav | post24hFav | post24hAdv |' : '';
  const exSep = excursions ? '---|---|---|---|---|' : '';
  p(`| # | 方向 | ロット | エントリー価格 | 決済価格 | 開始 | 終了 | 保有期間 | pips | 損益 |${exCols}`);
  p(`|---|---|---|---|---|---|---|---|---|---|${exSep}`);
  sorted.forEach((t, i) => {
    const prec = pricePrecision(t.openPrice);
    const ex = excursions?.get(t.id);
    const exVals = excursions
      ? ` ${nn(ex?.maePips ?? null, v => v.toFixed(1))} | ${nn(ex?.mfePips ?? null, v => v.toFixed(1))} | ${nn(ex?.post12hFavPips ?? null, v => v.toFixed(1))} | ${nn(ex?.post24hFavPips ?? null, v => v.toFixed(1))} | ${nn(ex?.post24hAdvPips ?? null, v => v.toFixed(1))} |`
      : '';
    p(`| ${i + 1} | ${t.side} | ${t.lots.toLocaleString('ja-JP')} | ${t.openPrice.toFixed(prec)} | ${t.closePrice.toFixed(prec)} | ${fmtDateTimeFull(t.openTime)} | ${fmtDateTimeFull(t.closeTime)} | ${fmtDurationFull(t.closeTime - t.openTime)} | ${tradePips(t) >= 0 ? '+' : ''}${tradePips(t).toFixed(1)} | ${money(sym, t.pnl)} |${exVals}`);
  });
  p('');

  return lines.join('\n');
}

export function downloadAiAnalysis(params: Parameters<typeof buildAiAnalysisMarkdown>[0], filenameHint: string): void {
  const md = buildAiAnalysisMarkdown(params);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  a.download = `${filenameHint}_ai分析_${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
