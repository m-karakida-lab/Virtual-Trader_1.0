import { useEffect, useRef, useState } from 'react';
import { CHART_FONT_FAMILY } from '../lib/chartTheme';
import { TIMEFRAMES, type TimeframeSec } from '../types';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// Unix秒（UTC）→ "YYYY/MM/DD(曜) HH:mm"。現在時刻表示用
function fmtCurrentTime(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const wd = WEEKDAY_LABELS[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}/${mo}/${day}(${wd}) ${hh}:${mm}`;
}

// TradingView風のパネルヘッダー（左上の「シンボル + 時間足」表示 + 全画面切替）。
// onSelectTimeframe を渡すと時間足部分がクリックで開くドロップダウンになる。
// currentTime（リプレイ中の現在足時刻・Unix秒）を渡すと同じ行の右側に日付時刻を表示する
// 「この時間足のみ表示」のドロップダウンに出す1種類ぶん（水平線なら複数あっても1項目）
export interface RestrictOption {
  kind: 'h' | 'v' | 'rect' | 'trend' | 'channel' | 'arrow' | 'brush' | 'text';
  label: string;
  count: number; // このパネルの時間足で今表示中の個数（表示だけ、0件の種類はそもそも渡さない）
}

export function ChartHeader({
  symbol, timeframeLabel, timeframeSec, onSelectTimeframe, disabled = false,
  isFullscreen, onToggleFullscreen, currentTime, atrPips, chartRightMargin = 0,
  restoreLayoutLabel = '4画面', tradeMarkersVisible, onToggleTradeMarkers,
  restrictOptions, onRestrictKind, restoreOptions, onRestoreKind,
}: {
  symbol: string;
  timeframeLabel: string;
  timeframeSec?: TimeframeSec;
  onSelectTimeframe?: (sec: TimeframeSec) => void;
  disabled?: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  currentTime?: number;
  atrPips?: number | null; // 今のボラティリティの目安（ATR14をpips換算）。日付ピルの左に小さく表示
  chartRightMargin?: number;
  restoreLayoutLabel?: string; // 1画面解除時に戻る先のレイアウト名（ボタンのtitleに使う）
  tradeMarkersVisible?: boolean; // このパネルの時間足でトレード履歴マーカーを表示中か
  onToggleTradeMarkers?: () => void; // 省略時はトレード履歴の表示/非表示ボタン自体を出さない
  restrictOptions?: RestrictOption[]; // このパネルの時間足で今表示中の描画種類の一覧（空配列でもボタン自体は出す）
  onRestrictKind?: (kind: RestrictOption['kind']) => void; // 省略時は「この時間足のみ表示」ボタン自体を出さない
  restoreOptions?: RestrictOption[]; // このパネルの時間足で今非表示中の描画種類の一覧（restrictの逆）
  onRestoreKind?: (kind: RestrictOption['kind']) => void; // 「全時間足で表示に戻す」。省略時はその項目群を出さない
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [restrictOpen, setRestrictOpen] = useState(false);
  const restrictRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!restrictOpen) return;
    const onClick = (e: MouseEvent) => {
      if (restrictRef.current && !restrictRef.current.contains(e.target as Node)) setRestrictOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [restrictOpen]);

  return (
    <>
    {currentTime !== undefined && (
      <div style={{
        position: 'absolute', top: 8, right: chartRightMargin + 10, zIndex: 12,
        display: 'flex', alignItems: 'center', gap: '6px',
        pointerEvents: 'none', fontFamily: CHART_FONT_FAMILY,
      }}>
        {atrPips !== undefined && atrPips !== null && (
          <div
            title="ATR(14): 直近の平均的な値幅から見た今のボラティリティの目安"
            style={{
              background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
              borderRadius: '8px', padding: '4px 8px',
              color: 'rgba(255,255,255,0.6)', fontSize: '14px', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            ATR(14) {atrPips.toFixed(1)}p
          </div>
        )}
        <div style={{
          background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
          borderRadius: '8px', padding: '4px 8px',
          color: 'rgba(255,255,255,0.9)', fontSize: '14px', fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {fmtCurrentTime(currentTime)}
        </div>
      </div>
    )}
    <div style={{
      // z-index: lightweight-charts が自前で挿入する内部canvasもz-index:2を使うため、
      // 同値だとDOM順序次第でチャート側が上に来てクリックを奪ってしまう。
      // 他のDOMオーバーレイ（垂直線・区切り線等、z-index 10〜13）と同じ帯に上げて確実に最前面にする
      position: 'absolute', top: 8, left: 10, zIndex: 12,
      display: 'flex', alignItems: 'center', gap: '6px',
      pointerEvents: 'none', fontFamily: CHART_FONT_FAMILY,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        // 半透明のまま(rgba(255,255,255,0.12))だと、真下を横切る区切り線・十字カーソルの
        // 点線がうっすら透けて見えてしまう。チャート背景色(#0d0d0d)を下地に敷いてから
        // 半透明の白を重ねることで、見た目の色はそのままに完全に不透明な板にする
        background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
        borderRadius: '8px',
        padding: '4px 8px',
      }}>
        {/* 銘柄名は今のところ選択肢が1つ（読み込んだファイルの通貨ペア）しか無いため、
            ドロップダウンとしては機能させない。シェブロンも付けない（クリックできないものに
            「開ける」矢印を付けると紛らわしいため） */}
        <span style={{
          color: 'rgba(255,255,255,0.9)', fontSize: '14px', fontWeight: 600, letterSpacing: '0.25em',
        }}>
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
                display: 'flex', alignItems: 'center', gap: '2px',
                background: 'none', border: 'none', padding: 0,
                color: 'rgba(255,255,255,0.75)', fontSize: '12px', fontWeight: 600,
                fontFamily: CHART_FONT_FAMILY, cursor: disabled ? 'default' : 'pointer',
              }}
            >{timeframeLabel}<ChevronDown color="rgba(255,255,255,0.6)" flipped={open} /></button>
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
          <span style={{
            display: 'flex', alignItems: 'center', gap: '2px',
            color: 'rgba(255,255,255,0.75)', fontSize: '12px', fontWeight: 600,
          }}>{timeframeLabel}<ChevronDown color="rgba(255,255,255,0.6)" /></span>
        )}
      </div>
      {onToggleTradeMarkers && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onMouseUp={e => e.stopPropagation()}
          onClick={() => !disabled && onToggleTradeMarkers()}
          disabled={disabled}
          title={tradeMarkersVisible ? 'この時間足のトレード履歴を非表示にする' : 'この時間足のトレード履歴を表示する'}
          style={{
            width: '28px', height: '28px', pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
            border: 'none', borderRadius: '8px',
            color: tradeMarkersVisible ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)',
            cursor: disabled ? 'default' : 'pointer', padding: 0, fontSize: '14px',
          }}
        >🏷</button>
      )}
      <button
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onClick={() => !disabled && onToggleFullscreen()}
        disabled={disabled}
        title={isFullscreen ? `${restoreLayoutLabel}表示に戻す` : 'この時間足を1画面表示にする'}
        style={{
          width: '28px', height: '28px', pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          // 銘柄/時間軸のピルと同じ背景色に揃える（不透明にする理由もピルと同じ:
          // 下地(#0d0d0d)を敷いてから重ねることで、下を横切る線が透けないようにする）
          background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
          border: 'none', borderRadius: '8px',
          color: 'rgba(255,255,255,0.75)', cursor: disabled ? 'default' : 'pointer', padding: 0,
        }}
      >
        {isFullscreen ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 15 3 15 3 21" /><polyline points="15 9 21 9 21 3" />
            <line x1="3" y1="21" x2="10" y2="14" /><line x1="21" y1="3" x2="14" y2="10" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        )}
      </button>
      {onRestrictKind && (
        <div ref={restrictRef} style={{ position: 'relative', pointerEvents: 'auto' }}>
          <button
            onMouseDown={e => e.stopPropagation()}
            onMouseUp={e => e.stopPropagation()}
            onClick={() => !disabled && setRestrictOpen(o => !o)}
            disabled={disabled}
            title="この時間足のみ表示（描画をこの時間足だけに絞り込む）"
            style={{
              width: '28px', height: '28px', pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(rgba(255,255,255,0.12), rgba(255,255,255,0.12)), #0d0d0d',
              border: 'none', borderRadius: '8px',
              color: 'rgba(255,255,255,0.75)', cursor: disabled ? 'default' : 'pointer', padding: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {restrictOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
              padding: '4px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
              display: 'flex', flexDirection: 'column', minWidth: '180px',
            }}>
              {(restrictOptions ?? []).length === 0 && (restoreOptions ?? []).length === 0 ? (
                <span style={{
                  padding: '6px 10px', fontSize: '13px', color: '#666', fontFamily: CHART_FONT_FAMILY,
                }}>この時間足に描画はありません</span>
              ) : (
                <>
                  {(restrictOptions ?? []).length > 0 && (
                    <>
                      <span style={{
                        padding: '4px 10px', fontSize: '11px', color: '#666', fontFamily: CHART_FONT_FAMILY,
                      }}>この時間足のみ表示にする</span>
                      {(restrictOptions ?? []).map(o => (
                        <button
                          key={o.kind}
                          onMouseDown={e => e.stopPropagation()}
                          onMouseUp={e => e.stopPropagation()}
                          onClick={() => { onRestrictKind(o.kind); setRestrictOpen(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                            background: 'none', border: 'none', color: '#e0e0e0',
                            padding: '6px 10px', fontSize: '13px', textAlign: 'left', cursor: 'pointer',
                            borderRadius: '4px', fontFamily: CHART_FONT_FAMILY,
                          }}
                        >
                          <span>{o.label}</span>
                          <span style={{ color: '#666' }}>{o.count}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {onRestoreKind && (restoreOptions ?? []).length > 0 && (
                    <>
                      <span style={{
                        padding: '4px 10px', fontSize: '11px', color: '#666', fontFamily: CHART_FONT_FAMILY,
                        marginTop: (restrictOptions ?? []).length > 0 ? '4px' : 0,
                        borderTop: (restrictOptions ?? []).length > 0 ? '1px solid #2a2a2a' : 'none',
                        paddingTop: (restrictOptions ?? []).length > 0 ? '8px' : '4px',
                      }}>全時間足で表示に戻す</span>
                      {(restoreOptions ?? []).map(o => (
                        <button
                          key={o.kind}
                          onMouseDown={e => e.stopPropagation()}
                          onMouseUp={e => e.stopPropagation()}
                          onClick={() => { onRestoreKind(o.kind); setRestrictOpen(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                            background: 'none', border: 'none', color: '#e0e0e0',
                            padding: '6px 10px', fontSize: '13px', textAlign: 'left', cursor: 'pointer',
                            borderRadius: '4px', fontFamily: CHART_FONT_FAMILY,
                          }}
                        >
                          <span>{o.label}</span>
                          <span style={{ color: '#666' }}>{o.count}</span>
                        </button>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

// 開閉可能なドロップダウンだと分かるように添える小さな下向きシェブロン。
// flippedがtrueの間は開いている状態を示すため上向きに反転する
function ChevronDown({ color, flipped = false }: { color: string; flipped?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24" width="10" height="10" fill="none" stroke={color} strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: flipped ? 'rotate(180deg)' : 'none', flexShrink: 0 }}
    >
      <path d="M5 8l7 7 7-7" />
    </svg>
  );
}
