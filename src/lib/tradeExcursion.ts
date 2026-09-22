// 決済済みトレードの「保有中の含み損益の振れ幅（MAE/MFE）」と「決済後の値動き」を
// 1分足まで遡って事後計算する。バックテストなので決済後のデータも既にCSVに含まれており、
// リアルタイムに追跡・記録する仕組みは不要——DuckDBへその都度クエリして導出する純粋な
// 導出データという位置づけ（tradeStats.tsと同じ思想。ClosedTrade型自体は変更しない）。
//
// 用途: 「早めの損切り（ナイスカット）」だったのか「ノイズに狩られただけ」だったのかを
// 事後検証するための材料。あくまでヒンドサイト分析であり、「次から握り続けろ」という
// 結論には直結しない（当時は将来の値動きを知り得ない）——利用側（UI・AIエクスポート）で
// その注意書きを必ず添えること
import * as duckdb from '@duckdb/duckdb-wasm';
import type { Candle, ClosedTrade } from '../types';
import { queryCandlesInRanges } from './duckdb';
import { inferPipSize } from './pips';

const HOUR_SEC = 3600;
// ブローカー時間→JST変換は+6h/+7hのどちらか（DST次第）なので、JST時刻から逆算した
// ブローカー時間の候補範囲を広めに取っておけば必ず実データを含む
const BROKER_OFFSET_MARGIN_SEC = 4 * HOUR_SEC;

export interface TradeExcursion {
  maePips: number | null;  // 保有中の最大逆行幅（正の値＝含み損の最大値）
  mfePips: number | null;  // 保有中の最大順行幅（正の値＝含み益の最大値）
  post12hFavPips: number | null; // 決済後12時間以内、エントリー方向に見て最も有利に動いた値幅
  post24hFavPips: number | null; // 決済後24時間以内、同上
  post24hAdvPips: number | null; // 決済後24時間以内、エントリー方向に見て最も不利に動いた値幅（さらなる逆行の確認用）
}

function jstToBrokerRange(fromJST: number, toJST: number): { lo: number; hi: number } {
  return { lo: fromJST - 7 * HOUR_SEC - BROKER_OFFSET_MARGIN_SEC, hi: toJST - 6 * HOUR_SEC + BROKER_OFFSET_MARGIN_SEC };
}

// candles（time昇順）の中から time >= t となる最初のインデックスを返す（無ければlength）
function lowerBound(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export async function computeTradeExcursions(
  instance: duckdb.AsyncDuckDB,
  trades: ClosedTrade[],
): Promise<Map<number, TradeExcursion>> {
  const result = new Map<number, TradeExcursion>();
  if (trades.length === 0) return result;

  // 保有中(open〜close)と決済後24hの両方をまとめて1つの範囲にして、トレードごとに
  // まとめて1クエリで取得する（トレード件数分クエリを打たない）
  const ranges = trades.map(t => jstToBrokerRange(t.openTime, t.closeTime + 24 * HOUR_SEC));
  const candles = await queryCandlesInRanges(instance, ranges);

  for (const t of trades) {
    const dir = t.side === 'BUY' ? 1 : -1;
    const pip = inferPipSize(t.openPrice);

    // 保有中: [openTime, closeTime)
    const holdStart = lowerBound(candles, t.openTime);
    const holdEnd = lowerBound(candles, t.closeTime);
    let maePrice = 0, mfePrice = 0, haveHold = false;
    for (let i = holdStart; i < holdEnd; i++) {
      const c = candles[i];
      const adverse = dir === 1 ? t.openPrice - c.low : c.high - t.openPrice;
      const favorable = dir === 1 ? c.high - t.openPrice : t.openPrice - c.low;
      maePrice = Math.max(maePrice, adverse);
      mfePrice = Math.max(mfePrice, favorable);
      haveHold = true;
    }
    // 保有時間が1分未満等でローソク足が1本も取れない場合は、エントリー価格と決済価格の
    // 差分だけでも最低限の値として使う（無いよりまし。フルの振れ幅ではない点は注意）
    if (!haveHold) {
      const adverse = dir === 1 ? t.openPrice - Math.min(t.openPrice, t.closePrice) : Math.max(t.openPrice, t.closePrice) - t.openPrice;
      const favorable = dir === 1 ? Math.max(t.openPrice, t.closePrice) - t.openPrice : t.openPrice - Math.min(t.openPrice, t.closePrice);
      maePrice = adverse;
      mfePrice = favorable;
    }

    // 決済後: [closeTime, closeTime+12h) / [closeTime, closeTime+24h)
    const post12hEnd = lowerBound(candles, t.closeTime + 12 * HOUR_SEC);
    const post24hEnd = lowerBound(candles, t.closeTime + 24 * HOUR_SEC);
    const postStart = lowerBound(candles, t.closeTime);
    let post12hFav: number | null = null;
    let post24hFav: number | null = null, post24hAdv: number | null = null;
    for (let i = postStart; i < post24hEnd; i++) {
      const c = candles[i];
      const fav = dir === 1 ? c.high - t.closePrice : t.closePrice - c.low;
      const adv = dir === 1 ? t.closePrice - c.low : c.high - t.closePrice;
      if (i < post12hEnd) post12hFav = Math.max(post12hFav ?? 0, fav);
      post24hFav = Math.max(post24hFav ?? 0, fav);
      post24hAdv = Math.max(post24hAdv ?? 0, adv);
    }

    result.set(t.id, {
      maePips: maePrice / pip,
      mfePips: mfePrice / pip,
      post12hFavPips: post12hFav === null ? null : post12hFav / pip,
      post24hFavPips: post24hFav === null ? null : post24hFav / pip,
      post24hAdvPips: post24hAdv === null ? null : post24hAdv / pip,
    });
  }

  return result;
}

export interface ExcursionSummary {
  avgMaePips: number | null;
  avgMfePips: number | null;
  // 負けトレードのみ対象: 決済後24h以内に、負けた値幅と同じかそれ以上エントリー方向へ
  // 戻った（＝そのまま握っていれば建値以上まで回復していた）割合。高いほど「損切りが
  // ノイズに狩られただけ」だった疑いが強い。低いほど「素直に逆行を続けた＝適切な損切り」
  recoveredWithin24hPct: number | null;
  avgPostCloseFavPipsForLosses: number | null;
}

export function summarizeExcursions(trades: ClosedTrade[], excursions: Map<number, TradeExcursion>): ExcursionSummary {
  const withExcursion = trades.map(t => ({ t, e: excursions.get(t.id) })).filter(x => x.e);
  const maeVals = withExcursion.map(x => x.e!.maePips).filter((v): v is number => v !== null);
  const mfeVals = withExcursion.map(x => x.e!.mfePips).filter((v): v is number => v !== null);
  const avgMaePips = maeVals.length > 0 ? maeVals.reduce((s, v) => s + v, 0) / maeVals.length : null;
  const avgMfePips = mfeVals.length > 0 ? mfeVals.reduce((s, v) => s + v, 0) / mfeVals.length : null;

  const pipOf = (t: ClosedTrade) => {
    const dir = t.side === 'BUY' ? 1 : -1;
    return ((t.closePrice - t.openPrice) * dir) / inferPipSize(t.openPrice);
  };
  const losses = withExcursion.filter(x => x.t.pnl < 0 && x.e!.post24hFavPips !== null);
  const recovered = losses.filter(x => x.e!.post24hFavPips! >= Math.abs(pipOf(x.t)));
  const recoveredWithin24hPct = losses.length > 0 ? (recovered.length / losses.length) * 100 : null;
  const favVals = losses.map(x => x.e!.post24hFavPips!);
  const avgPostCloseFavPipsForLosses = favVals.length > 0 ? favVals.reduce((s, v) => s + v, 0) / favVals.length : null;

  return { avgMaePips, avgMfePips, recoveredWithin24hPct, avgPostCloseFavPipsForLosses };
}
