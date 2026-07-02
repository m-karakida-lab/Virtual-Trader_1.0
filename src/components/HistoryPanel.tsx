import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import { currencySymbol } from '../lib/currency';
import { pricePrecision } from '../lib/pips';

const fmt = (n: number) => Math.round(n).toLocaleString('ja-JP');

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
