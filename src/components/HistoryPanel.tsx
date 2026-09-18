import { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { ClosedTrade } from '../types';
import { currencySymbol } from '../lib/currency';
import { pricePrecision } from '../lib/pips';

const fmt = (n: number) => Math.round(n).toLocaleString('ja-JP');

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
  const totalPnl = sorted.reduce((sum, t) => sum + t.pnl, 0);
  const wins = sorted.filter(t => t.pnl > 0).length;
  const winRate = sorted.length > 0 ? (wins / sorted.length) * 100 : 0;

  const stats = useMemo(() => computeStats(closedTrades), [closedTrades]);
  const maxAbsSidePnl = Math.max(Math.abs(stats.longPnl), Math.abs(stats.shortPnl));

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
          {sorted.length > 0 && (
            <span style={{ color: '#666', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
              {sorted.length}件 · 勝率 {winRate.toFixed(0)}% · 合計
              <span style={{ color: totalPnl >= 0 ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: '4px' }}>
                {totalPnl >= 0 ? '+' : ''}{sym}{fmt(totalPnl)}
              </span>
            </span>
          )}
        </div>
        <button onClick={toggleHistoryPanel} style={{
          background: 'none', border: '1px solid #444', color: '#aaa',
          borderRadius: '4px', padding: '6px 14px', cursor: 'pointer', fontSize: '14px',
        }}>閉じる</button>
      </div>

      {sorted.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px',
          padding: '14px 16px', marginBottom: '16px', border: '1px solid #1e1e1e',
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

      <div style={{ height: '220px', marginBottom: '16px', border: '1px solid #1e1e1e', borderRadius: '4px', flexShrink: 0 }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #1e1e1e', borderRadius: '4px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr style={{ color: '#666', textAlign: 'left', borderBottom: '1px solid #1e1e1e' }}>
              <th style={{ padding: '8px 12px' }}>方向</th>
              <th style={{ padding: '8px 12px' }}>ロット</th>
              <th style={{ padding: '8px 12px' }}>エントリー</th>
              <th style={{ padding: '8px 12px' }}>決済</th>
              <th style={{ padding: '8px 12px' }}>開始</th>
              <th style={{ padding: '8px 12px' }}>終了</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>損益</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#444' }}>まだ取引がありません</td></tr>
            ) : (
              [...sorted].reverse().map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #161616' }}>
                  <td style={{ padding: '6px 12px', color: t.side === 'BUY' ? '#26a69a' : '#ef5350', fontWeight: 700 }}>{t.side}</td>
                  <td style={{ padding: '6px 12px', color: '#888' }}>{t.lots.toLocaleString()}</td>
                  <td style={{ padding: '6px 12px', color: '#aaa' }}>{t.openPrice.toFixed(pricePrecision(t.openPrice))}</td>
                  <td style={{ padding: '6px 12px', color: '#aaa' }}>{t.closePrice.toFixed(pricePrecision(t.closePrice))}</td>
                  <td style={{ padding: '6px 12px', color: '#555' }}>{fmtDateTime(t.openTime)}</td>
                  <td style={{ padding: '6px 12px', color: '#555' }}>{fmtDateTime(t.closeTime)}</td>
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
  );
}
