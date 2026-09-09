import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import type { MagnetMode } from '../types';

// TradingView風のアイコンツールバー。クリックした瞬間にそのツールが有効化され、
// 続けてチャート上をクリック/ドラッグするだけで配置できる（配置後は自動的に解除される）。
// 色・線種・太さの編集は右上のPalettePanel（パレットモード）が一手に担う。
// 実際の配置・既存図形の一覧/削除は Controls.tsx の「描画」メニュー側が担う。
// 4画面時も1画面時と同じく、常に操作可能なメインパネル（CandleChart）に対して働く。
// 自身は絶対配置を持たず、App.tsx側でチャート領域の左に確保した専用列に配置される
// （以前はチャート上への絶対配置オーバーレイでローソク足と重なっていた）

const ICONS: Record<string, JSX.Element> = {
  hline: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="7" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  vline: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="7" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  ruler: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="9" width="18" height="6" rx="1" />
      <line x1="7" y1="9" x2="7" y2="12" />
      <line x1="11" y1="9" x2="11" y2="12" />
      <line x1="15" y1="9" x2="15" y2="12" />
      <line x1="19" y1="9" x2="19" y2="12" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="6" width="16" height="12" rx="1" />
    </svg>
  ),
  trend: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="19" x2="20" y2="6" />
      <circle cx="4" cy="19" r="2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="6" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  brush: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 18c0-4 3-7 6-7s3 2 2 4-3 3-4 1c-1-2 1-5 4-7 3-2 6-2 7 0" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 6h14M12 6v13" strokeLinecap="round" />
    </svg>
  ),
  magnet: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 4h4v9a3 3 0 0 1-6 0V9" />
      <path d="M17 4h-4v9a3 3 0 0 0 6 0V9" />
      <path d="M3 9h4M17 9h4" />
    </svg>
  ),
  // TradingViewの「連続描画」相当。ロック（鍵）アイコンで表す
  lock: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  // インジケータ・描画物の一括非表示。目に斜線（非表示中はスラッシュ有り）で表す
  eye: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="21" x2="21" y2="3" />
    </svg>
  ),
  // 他時間足へのジャンプ同期。狙いを定める的（クロスヘア）で「この足を指す」を表す
  jumpSync: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
    </svg>
  ),
};

function ToolButton({
  icon, title, active, disabled, onClick,
}: { icon: keyof typeof ICONS; title: string; active: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: '40px', height: '40px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: disabled ? 'transparent' : active ? '#2a2a2a' : 'transparent',
        color: disabled ? '#333' : active ? '#42a5f5' : '#888',
        border: 'none', borderRadius: '4px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0,
      }}
    >
      {ICONS[icon]}
    </button>
  );
}

// 矢印ボタン + ポップアップの共通枠。開閉と外側クリックでの自動クローズだけを担い、
// 中身（色・線種・太さ等）は children に委ねる
function StyleArrow({ title, children }: { title: string; disabled: boolean; children: React.ReactNode }) {
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
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={title}
        style={{
          width: '10px', height: '40px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'transparent', color: '#666',
          border: 'none', borderRadius: '4px', cursor: 'pointer', padding: 0,
        }}
      >
        <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor"><path d="M8 5l8 7-8 7z" /></svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', left: 'calc(100% + 6px)', top: 0,
          backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
          padding: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
          display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 'max-content',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

const MAGNET_STRENGTH_OPTIONS: { v: Exclude<MagnetMode, 'off'>; label: string }[] = [
  { v: 'weak', label: '弱' }, { v: 'strong', label: '強' },
];

// マグネットの強さ（弱/強）を選ぶ矢印つきポップアップ。他のStyleArrow系と同じく、
// 選ぶと同時にその強さでマグネットをONにする（オフの状態から矢印で選んでもすぐ使える）
function MagnetStrengthPopup({ disabled }: { disabled: boolean }) {
  const magnetMode = useTraderStore(s => s.magnetMode);
  const setMagnetMode = useTraderStore(s => s.setMagnetMode);

  return (
    <StyleArrow title="マグネットの強さ" disabled={disabled}>
      <div style={{ display: 'flex', gap: '3px' }}>
        {MAGNET_STRENGTH_OPTIONS.map(o => (
          <button
            key={o.v}
            onClick={() => setMagnetMode(o.v)}
            style={{
              backgroundColor: magnetMode === o.v ? '#2a2a2a' : '#161616',
              color: magnetMode === o.v ? '#e0e0e0' : '#666',
              border: magnetMode === o.v ? '1px solid #3a3a3a' : '1px solid #222',
              borderRadius: '3px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
            }}
          >{o.label}</button>
        ))}
      </div>
    </StyleArrow>
  );
}

// 水平線の価格ラベル・垂直線の日付ラベルのON/OFFを選ぶ矢印つきポップアップ。
// マグネットの強さ選択と同じ見た目・操作感に揃える。ボタン文言は「あり/なし」だけだと
// 何のON/OFFか分かりづらいという指摘を受け、subject（例:「価格ラベル」）を含めて明示する
function LabelTogglePopup({ title, subject, show, onToggle, disabled }: { title: string; subject: string; show: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <StyleArrow title={title} disabled={disabled}>
      <div style={{ display: 'flex', gap: '3px' }}>
        {([{ v: true, label: `${subject}あり` }, { v: false, label: `${subject}なし` }] as const).map(o => (
          <button
            key={String(o.v)}
            onClick={() => { if (show !== o.v) onToggle(); }}
            style={{
              backgroundColor: show === o.v ? '#2a2a2a' : '#161616',
              color: show === o.v ? '#e0e0e0' : '#666',
              border: show === o.v ? '1px solid #3a3a3a' : '1px solid #222',
              borderRadius: '3px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
            }}
          >{o.label}</button>
        ))}
      </div>
    </StyleArrow>
  );
}

export function DrawToolbar() {
  const isLoaded = useTraderStore(s => s.isLoaded);
  const isDrawingLine  = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring    = useTraderStore(s => s.isMeasuring);
  const isDrawingRect  = useTraderStore(s => s.isDrawingRect);
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const isDrawingText  = useTraderStore(s => s.isDrawingText);
  const toggleDrawLine  = useTraderStore(s => s.toggleDrawLine);
  const toggleDrawVLine = useTraderStore(s => s.toggleDrawVLine);
  const toggleMeasure   = useTraderStore(s => s.toggleMeasure);
  const toggleDrawRect  = useTraderStore(s => s.toggleDrawRect);
  const toggleDrawTrendLine = useTraderStore(s => s.toggleDrawTrendLine);
  const toggleDrawBrush = useTraderStore(s => s.toggleDrawBrush);
  const toggleDrawText  = useTraderStore(s => s.toggleDrawText);
  const magnetMode      = useTraderStore(s => s.magnetMode);
  const toggleMagnet    = useTraderStore(s => s.toggleMagnet);
  const continuousDrawing = useTraderStore(s => s.continuousDrawing);
  const toggleContinuousDrawing = useTraderStore(s => s.toggleContinuousDrawing);
  const overlaysHidden = useTraderStore(s => s.overlaysHidden);
  const toggleOverlaysHidden = useTraderStore(s => s.toggleOverlaysHidden);
  const isJumpSync = useTraderStore(s => s.isJumpSync);
  const toggleJumpSync = useTraderStore(s => s.toggleJumpSync);
  const chartLayout = useTraderStore(s => s.chartLayout);
  const showHLinePriceLabel = useTraderStore(s => s.showHLinePriceLabel);
  const toggleHLinePriceLabel = useTraderStore(s => s.toggleHLinePriceLabel);
  const showVLineDateLabel = useTraderStore(s => s.showVLineDateLabel);
  const toggleVLineDateLabel = useTraderStore(s => s.toggleVLineDateLabel);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="hline" title="水平線" active={isDrawingLine} disabled={!isLoaded} onClick={toggleDrawLine} />
        <LabelTogglePopup title="価格ラベルの表示" subject="価格ラベル" show={showHLinePriceLabel} onToggle={toggleHLinePriceLabel} disabled={!isLoaded} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="vline" title="垂直線" active={isDrawingVLine} disabled={!isLoaded} onClick={toggleDrawVLine} />
        <LabelTogglePopup title="日付ラベルの表示" subject="日付ラベル" show={showVLineDateLabel} onToggle={toggleVLineDateLabel} disabled={!isLoaded} />
      </div>
      <ToolButton icon="ruler" title="ものさし" active={isMeasuring} disabled={!isLoaded} onClick={toggleMeasure} />
      <ToolButton icon="rect" title="四角形" active={isDrawingRect} disabled={!isLoaded} onClick={toggleDrawRect} />
      <ToolButton icon="trend" title="トレンドライン" active={isDrawingTrendLine} disabled={!isLoaded} onClick={toggleDrawTrendLine} />
      <ToolButton icon="brush" title="ブラシ" active={isDrawingBrush} disabled={!isLoaded} onClick={toggleDrawBrush} />
      <ToolButton icon="text" title="テキスト" active={isDrawingText} disabled={!isLoaded} onClick={toggleDrawText} />
      <span style={{ height: '1px', margin: '2px 4px', backgroundColor: '#2a2a2a' }} />
      <ToolButton
        icon="jumpSync"
        title={chartLayout === '4' ? 'このツールを有効化した後、いずれかのパネルで足をクリックすると他の枠がその時刻へ移動します' : '4画面表示でのみ使えます'}
        active={isJumpSync}
        disabled={!isLoaded || chartLayout !== '4'}
        onClick={toggleJumpSync}
      />
      <span style={{ height: '1px', margin: '2px 4px', backgroundColor: '#2a2a2a' }} />
      <ToolButton icon="lock" title="連続描画（配置してもツールを維持する）" active={continuousDrawing} disabled={!isLoaded} onClick={toggleContinuousDrawing} />
      <span style={{ height: '1px', margin: '2px 4px', backgroundColor: '#2a2a2a' }} />
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="magnet" title="マグネット（足のOHLCに吸着）" active={magnetMode !== 'off'} disabled={!isLoaded} onClick={toggleMagnet} />
        <MagnetStrengthPopup disabled={!isLoaded} />
      </div>
      <span style={{ height: '1px', margin: '2px 4px', backgroundColor: '#2a2a2a' }} />
      <ToolButton icon={overlaysHidden ? 'eyeOff' : 'eye'} title="インジケータ・描画を全て非表示（データは消えない）" active={overlaysHidden} disabled={!isLoaded} onClick={toggleOverlaysHidden} />
    </div>
  );
}
