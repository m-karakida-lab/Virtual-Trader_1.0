import { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { ClosedTrade } from '../types';
import { currencySymbol } from '../lib/currency';
import { pricePrecision } from '../lib/pips';
import { computeTradeStats } from '../lib/tradeStats';
import { SESSIONS } from '../lib/sessions';

const SESSION_COLOR: Record<string, string> = {
  ...Object.fromEntries(SESSIONS.map(s => [s.key, s.color])),
  other: '#666',
};

const fmt = (n: number) => Math.round(n).toLocaleString('ja-JP');

// 保有期間（決済-建玉）の表示用フォーマット。主要な2単位だけに絞る（分＋秒等の細かすぎる
// 表示は避ける。数分〜数ヶ月と幅が広いトレードを同じ書式で扱うための簡易表現）
function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const totalMin = Math.floor(sec / 60);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分`);
  return parts.slice(0, 2).join(' ');
}

// ラベルと値の間はspace-betweenで箱の端まで離すと、箱の横幅が広い時に間延びして見づらい
// という指摘を受け、ラベル側を固定幅にして値をすぐ隣に詰めて置く方式にした
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '10px', fontSize: '13px', padding: '3px 0' }}>
      <span style={{ color: '#888', width: '190px', flexShrink: 0, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ color: '#ddd', fontVariantNumeric: 'tabular-nums', fontWeight: 600, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

// セッション別分析の1行。件数＋損益（正負で色分けした横棒）を横並びで見せる
function SessionStatRow({
  label, color, count, pnl, sym, maxAbs,
}: {
  label: string; color: string; count: number; pnl: number; sym: string; maxAbs: number;
}) {
  const pct = maxAbs > 0 ? (Math.abs(pnl) / maxAbs) * 100 : 0;
  const barColor = pnl >= 0 ? '#26a69a' : '#ef5350';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />
      <span style={{ width: '76px', flexShrink: 0, fontSize: '13px', color: '#aaa' }}>{label}</span>
      <span style={{ width: '44px', flexShrink: 0, fontSize: '12px', color: '#666', textAlign: 'right' }}>{count}件</span>
      <div style={{ flex: 1, height: '10px', backgroundColor: '#1a1a1a', borderRadius: '5px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: barColor }} />
      </div>
      <span style={{
        width: '110px', flexShrink: 0, textAlign: 'right', fontSize: '13px', fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color: barColor,
      }}>{pnl >= 0 ? '+' : ''}{sym}{fmt(pnl)}</span>
    </div>
  );
}

function StatGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #1e1e1e', borderRadius: '4px', padding: '12px 14px', width: 'fit-content' }}>
      <div style={{
        color: '#42a5f5', fontSize: '14px', fontWeight: 700, marginBottom: '8px',
        paddingBottom: '6px', borderBottom: '1px solid #2a2a2a',
      }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

// 2つの内訳（勝敗・ロング/ショート等）を横棒1本で示す簡易チャート。
// 件数・金額どちらでも使えるよう「表示用ラベル文字列」を呼び出し側で作って渡す
function SplitBar({
  aLabel, aValue, aColor, bLabel, bValue, bColor,
}: {
  aLabel: string; aValue: number; aColor: string;
  bLabel: string; bValue: number; bColor: string;
}) {
  const total = aValue + bValue;
  const aPct = total > 0 ? (aValue / total) * 100 : 50;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
        <span style={{ color: aColor, fontWeight: 700 }}>{aLabel}</span>
        <span style={{ color: bColor, fontWeight: 700 }}>{bLabel}</span>
      </div>
      <div style={{ height: '10px', borderRadius: '5px', overflow: 'hidden', display: 'flex', backgroundColor: '#1a1a1a' }}>
        {total > 0 ? (
          <>
            <div style={{ width: `${aPct}%`, backgroundColor: aColor }} />
            <div style={{ width: `${100 - aPct}%`, backgroundColor: bColor }} />
          </>
        ) : null}
      </div>
    </div>
  );
}

// 符号付き金額（ロング利益・ショート利益）を、正負で色分けした横棒で比較する簡易チャート。
// ゼロを起点に左右へ伸ばすのではなく、単純に絶対値の比率で棒の長さを揃える（値の大小比較が目的で
// 収支の対称性までは要らないため。マイナスは赤、プラスは緑で判別できれば十分）
function SignedBarRow({ label, value, sym, maxAbs }: { label: string; value: number; sym: string; maxAbs: number }) {
  const pct = maxAbs > 0 ? (Math.abs(value) / maxAbs) * 100 : 0;
  const color = value >= 0 ? '#26a69a' : '#ef5350';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ width: '52px', flexShrink: 0, fontSize: '13px', color: '#888' }}>{label}</span>
      <div style={{ flex: 1, height: '10px', backgroundColor: '#1a1a1a', borderRadius: '5px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} />
      </div>
      <span style={{
        width: '110px', flexShrink: 0, textAlign: 'right', fontSize: '13px', fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color,
      }}>{value >= 0 ? '+' : ''}{sym}{fmt(value)}</span>
    </div>
  );
}

interface PerformanceStats {
  total: number; wins: number; losses: number;
  longCount: number; shortCount: number;
  longPnl: number; shortPnl: number;
}

function computeStats(trades: ClosedTrade[]): PerformanceStats {
  let wins = 0, losses = 0, longCount = 0, shortCount = 0, longPnl = 0, shortPnl = 0;
  for (const t of trades) {
    if (t.pnl > 0) wins++; else if (t.pnl < 0) losses++;
    if (t.side === 'BUY') { longCount++; longPnl += t.pnl; } else { shortCount++; shortPnl += t.pnl; }
  }
  return { total: trades.length, wins, losses, longCount, shortCount, longPnl, shortPnl };
}

function fmtDateTime(sec: number): string {
  const d = new Date(sec * 1000);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${M}/${D} ${hh}:${mm}`;
}

export function HistoryPanel() {
  const closedTrades   = useTraderStore(s => s.closedTrades);
  const initialBalance = useTraderStore(s => s.initialBalance);
  const quoteCurrency   = useTraderStore(s => s.quoteCurrency);
  const toggleHistoryPanel = useTraderStore(s => s.toggleHistoryPanel);
  const sym = currencySymbol(quoteCurrency);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const sorted = [...closedTrades].sort((a, b) => a.closeTime - b.closeTime);

  const stats = useMemo(() => computeStats(closedTrades), [closedTrades]);
  const maxAbsSidePnl = Math.max(Math.abs(stats.longPnl), Math.abs(stats.shortPnl));
  const rs = useMemo(() => computeTradeStats(closedTrades, initialBalance), [closedTrades, initialBalance]);
  const maxAbsSessionPnl = Math.max(...rs.bySession.map(s => Math.abs(s.pnl)));

  // リスク・パフォーマンス指標セクション専用のフォーマッタ（symは通貨記号、rsはcomputeTradeStatsの結果）
  const fmtMoney = (n: number) => `${n >= 0 ? '+' : ''}${sym}${fmt(n)}`;
  const fmtMoneyAbs = (n: number) => `${sym}${fmt(Math.abs(n))}`;
  const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`;
  const nn = <T,>(v: T | null, f: (v: T) => string) => v === null ? '—' : f(v);

  // チャート初期化（マウント時1回のみ）
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0d0d0d' }, textColor: '#888', fontSize: 12 },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      rightPriceScale: { borderColor: '#1e1e1e' },
      timeScale: { borderColor: '#1e1e1e', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addLineSeries({ color: '#42a5f5', lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  // エクイティカーブの再描画
  useEffect(() => {
    if (!seriesRef.current) return;
    let bal = initialBalance;
    const data: { time: Time; value: number }[] = [];
    if (sorted.length > 0) {
      data.push({ time: (sorted[0].closeTime - 1) as Time, value: bal });
      for (const t of sorted) {
        bal += t.pnl;
        data.push({ time: t.closeTime as Time, value: bal });
      }
    }
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedTrades, initialBalance]);

  return (
    <div style={{
      position: 'absolute', inset: 0, backgroundColor: 'rgba(5,5,5,0.92)',
      zIndex: 100, display: 'flex', flexDirection: 'column', padding: '20px 24px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px' }}>
          <span style={{ color: '#e0e0e0', fontSize: '18px', fontWeight: 700 }}>取引履歴</span>
        </div>
        <button onClick={toggleHistoryPanel} style={{
          background: 'none', border: '1px solid #444', color: '#aaa',
          borderRadius: '4px', padding: '6px 14px', cursor: 'pointer', fontSize: '14px',
        }}>閉じる</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {sorted.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px',
            padding: '14px 16px', border: '1px solid #1e1e1e',
            borderRadius: '4px', flexShrink: 0,
          }}>
            <div style={{ gridColumn: '1 / -1', color: '#888', fontSize: '13px', fontWeight: 700 }}>■パフォーマンス分析</div>

            <div>
              <div style={{ color: '#666', fontSize: '12px', marginBottom: '8px' }}>総取引数 {stats.total}</div>
              <SplitBar
                aLabel={`勝ち ${stats.wins}`} aValue={stats.wins} aColor="#26a69a"
                bLabel={`負け ${stats.losses}`} bValue={stats.losses} bColor="#ef5350"
              />
            </div>

            <div>
              <div style={{ color: '#666', fontSize: '12px', marginBottom: '8px' }}>ポジション</div>
              <SplitBar
                aLabel={`ロング ${stats.longCount}`} aValue={stats.longCount} aColor="#42a5f5"
                bLabel={`ショート ${stats.shortCount}`} bValue={stats.shortCount} bColor="#ab47bc"
              />
            </div>

            <div>
              <div style={{ color: '#666', fontSize: '12px', marginBottom: '8px' }}>利益（方向別）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <SignedBarRow label="ロング" value={stats.longPnl} sym={sym} maxAbs={maxAbsSidePnl} />
                <SignedBarRow label="ショート" value={stats.shortPnl} sym={sym} maxAbs={maxAbsSidePnl} />
              </div>
            </div>
          </div>
        )}

        {sorted.length > 0 && (
          <div style={{ border: '1px solid #1e1e1e', borderRadius: '4px', padding: '14px 16px', flexShrink: 0 }}>
            <div style={{ color: '#888', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>■セッション別分析</div>
            <div style={{ color: '#555', fontSize: '11px', marginBottom: '8px' }}>エントリー時刻（JST）が属するセッション基準</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {rs.bySession.map(s => (
                <SessionStatRow
                  key={s.key} label={s.label} color={SESSION_COLOR[s.key]}
                  count={s.count} pnl={s.pnl} sym={sym} maxAbs={maxAbsSessionPnl}
                />
              ))}
            </div>
          </div>
        )}

        {sorted.length > 0 && (
          <div style={{ border: '1px solid #1e1e1e', borderRadius: '4px', padding: '14px 16px', flexShrink: 0 }}>
            <div style={{ color: '#888', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>■リスクとパフォーマンス指標</div>
            {/* grid 2列だと箱がパネル半分の幅まで伸び、中身（ラベル+値）はその半分しか
                使わないので右側が丸ごと空いて間延びして見えた。箱自体を中身の幅に合わせて
                flex-wrapで並べる方式に変更（StatGroupのmaxWidth参照） */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <StatGroup title="収入">
                <StatRow label="純利益" value={fmtMoney(rs.netProfit)} />
                <StatRow label="平均トレード損益" value={fmtMoney(rs.avgTradePnl)} />
                <StatRow label="利益総計" value={fmtMoneyAbs(rs.grossProfit)} />
                <StatRow label="損失総計" value={fmtMoneyAbs(rs.grossLoss)} />
                <StatRow label="月平均利益" value={fmtMoney(rs.avgMonthlyProfit)} />
                <StatRow label="利益平均額" value={fmtMoneyAbs(rs.avgWin)} />
                <StatRow label="損失平均額" value={fmtMoneyAbs(rs.avgLoss)} />
                <StatRow label="最大ドローダウン" value={fmtMoneyAbs(rs.maxDrawdown)} />
                <StatRow label="当日最大損失率" value={nn(rs.maxDailyLossPct, v => fmtPct(v))} />
                <StatRow label="プロフィットファクター" value={nn(rs.profitFactor, v => v.toFixed(2))} />
                <StatRow label="リターン" value={nn(rs.returnPct, v => fmtPct(v))} />
              </StatGroup>

              <StatGroup title="トレード数">
                <StatRow label="合計トレード" value={`${rs.totalTrades}`} />
                <StatRow label="Trading Days数" value={`${rs.tradingDays}`} />
                <StatRow label="勝ちトレード" value={`${rs.winCount}`} />
                <StatRow label="負けトレード" value={`${rs.lossCount}`} />
                <StatRow label="最大連続利益トレード数" value={`${rs.maxConsecutiveWins}`} />
                <StatRow label="最大連続損失トレード数" value={`${rs.maxConsecutiveLosses}`} />
                <StatRow label="1日平均のトレード数" value={nn(rs.avgTradesPerDay, v => v.toFixed(1))} />
                <StatRow label="月平均トレード数" value={nn(rs.avgTradesPerMonth, v => v.toFixed(1))} />
                <StatRow label="勝ちトレードの月平均回数" value={nn(rs.avgWinsPerMonth, v => v.toFixed(1))} />
                <StatRow label="負けトレードの月平均回数" value={nn(rs.avgLossesPerMonth, v => v.toFixed(1))} />
                <StatRow label="1トレードの最大利益" value={fmtMoneyAbs(rs.largestWin)} />
                <StatRow label="1トレードの最大損失" value={fmtMoneyAbs(rs.largestLoss)} />
              </StatGroup>

              <StatGroup title="時間">
                <StatRow label="経過日数" value={rs.elapsedDays.toFixed(1)} />
                <StatRow label="経過月数" value={rs.elapsedMonths.toFixed(1)} />
              </StatGroup>

              <StatGroup title="その他">
                <StatRow label="最大ロット" value={rs.maxLots.toLocaleString()} />
                <StatRow label="レストレーションファクター" value={nn(rs.restorationFactor, v => v.toFixed(2))} />
                <StatRow label="リライアビリティファクター" value={nn(rs.reliabilityFactor, v => v.toFixed(2))} />
                <StatRow label="勝率" value={nn(rs.winRatePct, v => fmtPct(v))} />
                <StatRow label="損失率" value={nn(rs.lossRatePct, v => fmtPct(v))} />
              </StatGroup>
            </div>
          </div>
        )}

        <div style={{ height: '220px', border: '1px solid #1e1e1e', borderRadius: '4px', flexShrink: 0 }}>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        <div style={{ border: '1px solid #1e1e1e', borderRadius: '4px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ color: '#666', textAlign: 'left', borderBottom: '1px solid #1e1e1e' }}>
                <th style={{ padding: '8px 12px' }}>方向</th>
                <th style={{ padding: '8px 12px' }}>ロット</th>
                <th style={{ padding: '8px 12px' }}>エントリー</th>
                <th style={{ padding: '8px 12px' }}>決済</th>
                <th style={{ padding: '8px 12px' }}>開始</th>
                <th style={{ padding: '8px 12px' }}>終了</th>
                <th style={{ padding: '8px 12px' }}>保有期間</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>損益</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: '#444' }}>まだ取引がありません</td></tr>
              ) : (
                [...sorted].reverse().map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #161616' }}>
                    <td style={{ padding: '6px 12px', color: t.side === 'BUY' ? '#26a69a' : '#ef5350', fontWeight: 700 }}>{t.side}</td>
                    <td style={{ padding: '6px 12px', color: '#888' }}>{t.lots.toLocaleString()}</td>
                    <td style={{ padding: '6px 12px', color: '#aaa' }}>{t.openPrice.toFixed(pricePrecision(t.openPrice))}</td>
                    <td style={{ padding: '6px 12px', color: '#aaa' }}>{t.closePrice.toFixed(pricePrecision(t.closePrice))}</td>
                    <td style={{ padding: '6px 12px', color: '#555' }}>{fmtDateTime(t.openTime)}</td>
                    <td style={{ padding: '6px 12px', color: '#555' }}>{fmtDateTime(t.closeTime)}</td>
                    <td style={{ padding: '6px 12px', color: '#666' }}>{fmtDuration(t.closeTime - t.openTime)}</td>
                    <td style={{
                      padding: '6px 12px', textAlign: 'right', fontWeight: 700,
                      color: t.pnl >= 0 ? '#26a69a' : '#ef5350',
                    }}>
                      {t.pnl >= 0 ? '+' : ''}{sym}{fmt(t.pnl)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
