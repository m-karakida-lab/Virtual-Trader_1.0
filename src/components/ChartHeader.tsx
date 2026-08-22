import { CHART_FONT_FAMILY } from '../lib/chartTheme';

// TradingView風のパネルヘッダー（左上の「シンボル + 時間足」表示）
export function ChartHeader({ symbol, timeframeLabel }: { symbol: string; timeframeLabel: string }) {
  return (
    <div style={{
      position: 'absolute', top: 8, left: 10, zIndex: 2,
      display: 'flex', alignItems: 'baseline', gap: '8px',
      pointerEvents: 'none', fontFamily: CHART_FONT_FAMILY,
    }}>
      <span style={{ color: '#d1d4dc', fontSize: '15px', fontWeight: 700, letterSpacing: '0.05em' }}>
        {symbol || '—'}
      </span>
      <span style={{ color: '#787b86', fontSize: '13px', fontWeight: 600 }}>{timeframeLabel}</span>
    </div>
  );
}
