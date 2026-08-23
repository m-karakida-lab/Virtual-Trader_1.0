import { useEffect, useRef, useState } from 'react';
import { CHART_FONT_FAMILY } from '../lib/chartTheme';
import { TIMEFRAMES, type TimeframeSec } from '../types';

// TradingView風のパネルヘッダー（左上の「シンボル + 時間足」表示）。
// onSelectTimeframe を渡すと時間足部分がクリックで開くドロップダウンになる
export function ChartHeader({
  symbol, timeframeLabel, timeframeSec, onSelectTimeframe, disabled = false,
}: {
  symbol: string;
  timeframeLabel: string;
  timeframeSec?: TimeframeSec;
  onSelectTimeframe?: (sec: TimeframeSec) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div style={{
      // z-index: lightweight-charts が自前で挿入する内部canvasもz-index:2を使うため、
      // 同値だとDOM順序次第でチャート側が上に来てクリックを奪ってしまう。
      // 他のDOMオーバーレイ（垂直線・区切り線等、z-index 10〜13）と同じ帯に上げて確実に最前面にする
      position: 'absolute', top: 8, left: 10, zIndex: 12,
      display: 'flex', alignItems: 'baseline', gap: '8px',
      pointerEvents: 'none', fontFamily: CHART_FONT_FAMILY,
    }}>
      <span style={{ color: '#d1d4dc', fontSize: '15px', fontWeight: 700, letterSpacing: '0.05em' }}>
        {symbol || '—'}
      </span>
      {onSelectTimeframe ? (
        <div ref={ref} style={{ position: 'relative', pointerEvents: 'auto' }}>
          <button
            onMouseDown={e => e.stopPropagation()}
            onMouseUp={e => e.stopPropagation()}
            onClick={() => !disabled && setOpen(o => !o)}
            disabled={disabled}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: '#787b86', fontSize: '13px', fontWeight: 600,
              fontFamily: CHART_FONT_FAMILY, cursor: disabled ? 'default' : 'pointer',
            }}
          >{timeframeLabel} {open ? '▴' : '▾'}</button>
          {open && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
              padding: '4px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
              display: 'flex', flexDirection: 'column', minWidth: '64px',
            }}>
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf.sec}
                  onMouseDown={e => e.stopPropagation()}
                  onMouseUp={e => e.stopPropagation()}
                  onClick={() => { onSelectTimeframe(tf.sec); setOpen(false); }}
                  style={{
                    background: tf.sec === timeframeSec ? '#1f1f1f' : 'none', border: 'none',
                    color: tf.sec === timeframeSec ? '#e0e0e0' : '#888',
                    padding: '6px 10px', fontSize: '13px', textAlign: 'left', cursor: 'pointer',
                    borderRadius: '4px', fontFamily: CHART_FONT_FAMILY,
                  }}
                >{tf.label}</button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <span style={{ color: '#787b86', fontSize: '13px', fontWeight: 600 }}>{timeframeLabel}</span>
      )}
    </div>
  );
}
