import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import { RECT_COLORS, LINE_COLORS, type LineWidth, type LineDash, type MagnetMode } from '../types';

// TradingView風の左端アイコンツールバー。クリックした瞬間にそのツールが有効化され、
// 続けてチャート上をクリック/ドラッグするだけで配置できる（配置後は自動的に解除される）。
// 実際の配置・既存図形の一覧/削除は Controls.tsx の「描画」メニュー側が担う。
// 4画面時も1画面時と同じく、常に操作可能なメインパネル（CandleChart）に対して働く

const WIDTH_OPTIONS: LineWidth[] = [1, 2, 3, 4];
const DASH_OPTIONS: { v: LineDash; label: string }[] = [
  { v: 'solid', label: '実線' }, { v: 'dashed', label: '破線' }, { v: 'dotted', label: '点線' },
];

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
  magnet: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 4h4v9a3 3 0 0 1-6 0V9" />
      <path d="M17 4h-4v9a3 3 0 0 0 6 0V9" />
      <path d="M3 9h4M17 9h4" />
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
          width: '18px', height: '40px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'transparent', color: '#666',
          border: 'none', borderRadius: '4px', cursor: 'pointer', padding: 0,
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5l8 7-8 7z" /></svg>
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

// 四角形の「次に描く色・太さ」（または選択中の四角形があればその色・太さ）を
// その場で選べる矢印つきポップアップ。中身は setRectDraft に委譲するだけで、
// 選択中の四角形があればそれを直接編集、無ければ次に描く四角形の既定値を変える
// （Controls.tsx の「描画」メニュー内の四角形スタイルピッカーと同じ挙動）
function RectStylePopup({ disabled }: { disabled: boolean }) {
  const rectDraft = useTraderStore(s => s.rectDraft);
  const setRectDraft = useTraderStore(s => s.setRectDraft);
  const selected = useTraderStore(s => s.selected);
  const rects = useTraderStore(s => s.rects);

  const selectedRect = selected?.kind === 'rect' ? rects.find(r => r.id === selected.id) : undefined;
  const activeStyle = selectedRect ?? rectDraft;

  return (
    <StyleArrow title="四角形の色・太さ" disabled={disabled}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {RECT_COLORS.map(c => (
          <button
            key={c}
            onClick={() => setRectDraft({ color: c })}
            style={{
              width: '18px', height: '18px', backgroundColor: c,
              border: activeStyle.color === c ? '2px solid #fff' : '2px solid transparent',
              borderRadius: '3px', cursor: 'pointer', padding: 0,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: '3px' }}>
        {WIDTH_OPTIONS.map(w => (
          <button
            key={w}
            onClick={() => setRectDraft({ width: w })}
            style={{
              backgroundColor: activeStyle.width === w ? '#2a2a2a' : '#161616',
              color: activeStyle.width === w ? '#e0e0e0' : '#666',
              border: activeStyle.width === w ? '1px solid #3a3a3a' : '1px solid #222',
              borderRadius: '3px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
            }}
          >{w}px</button>
        ))}
      </div>
    </StyleArrow>
  );
}

// 水平線・垂直線共通の「次に描く色・線種・太さ」（または選択中の線があればその設定）を
// その場で選べる矢印つきポップアップ。水平線・垂直線どちらの矢印から開いても同じ
// lineDraft/setLineDraft を共有する（Controls.tsx の水平線・垂直線スタイルピッカーと同じ）
function LineStylePopup({ title, disabled }: { title: string; disabled: boolean }) {
  const lineDraft = useTraderStore(s => s.lineDraft);
  const setLineDraft = useTraderStore(s => s.setLineDraft);
  const selected = useTraderStore(s => s.selected);
  const lines = useTraderStore(s => s.lines);
  const vlines = useTraderStore(s => s.vlines);

  const selectedLine  = selected?.kind === 'h' ? lines.find(l => l.id === selected.id) : undefined;
  const selectedVLine = selected?.kind === 'v' ? vlines.find(v => v.id === selected.id) : undefined;
  const activeStyle = selectedLine ?? selectedVLine ?? lineDraft;

  return (
    <StyleArrow title={title} disabled={disabled}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {LINE_COLORS.map(c => (
          <button
            key={c}
            onClick={() => setLineDraft({ color: c })}
            style={{
              width: '18px', height: '18px', borderRadius: '50%', backgroundColor: c,
              border: activeStyle.color === c ? '2px solid #fff' : '2px solid transparent',
              cursor: 'pointer', padding: 0,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: '3px' }}>
        {DASH_OPTIONS.map(d => (
          <button
            key={d.v}
            onClick={() => setLineDraft({ dash: d.v })}
            style={{
              backgroundColor: activeStyle.dash === d.v ? '#2a2a2a' : '#161616',
              color: activeStyle.dash === d.v ? '#e0e0e0' : '#666',
              border: activeStyle.dash === d.v ? '1px solid #3a3a3a' : '1px solid #222',
              borderRadius: '3px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
            }}
          >{d.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '3px' }}>
        {WIDTH_OPTIONS.map(w => (
          <button
            key={w}
            onClick={() => setLineDraft({ width: w })}
            style={{
              backgroundColor: activeStyle.width === w ? '#2a2a2a' : '#161616',
              color: activeStyle.width === w ? '#e0e0e0' : '#666',
              border: activeStyle.width === w ? '1px solid #3a3a3a' : '1px solid #222',
              borderRadius: '3px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
            }}
          >{w}px</button>
        ))}
      </div>
    </StyleArrow>
  );
}

const MAGNET_OPTIONS: { v: MagnetMode; label: string }[] = [
  { v: 'off', label: 'オフ' }, { v: 'weak', label: '弱' }, { v: 'strong', label: '強' },
];

// マグネット（描画時の価格スナップ）のON/OFF・強さを選ぶボタン。他のツールと違い
// クリックしても描画モードには入らず、常にポップアップで弱/強/オフを選ぶだけ
function MagnetButton({ disabled }: { disabled: boolean }) {
  const magnetMode = useTraderStore(s => s.magnetMode);
  const setMagnetMode = useTraderStore(s => s.setMagnetMode);
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
      <ToolButton
        icon="magnet"
        title="マグネット（足のOHLCに吸着）"
        active={magnetMode !== 'off'}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div style={{
          position: 'absolute', left: 'calc(100% + 6px)', top: 0,
          backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
          padding: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
          display: 'flex', gap: '3px', minWidth: 'max-content',
        }}>
          {MAGNET_OPTIONS.map(o => (
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
      )}
    </div>
  );
}

export function DrawToolbar() {
  const isLoaded = useTraderStore(s => s.isLoaded);
  const isDrawingLine  = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring    = useTraderStore(s => s.isMeasuring);
  const isDrawingRect  = useTraderStore(s => s.isDrawingRect);
  const toggleDrawLine  = useTraderStore(s => s.toggleDrawLine);
  const toggleDrawVLine = useTraderStore(s => s.toggleDrawVLine);
  const toggleMeasure   = useTraderStore(s => s.toggleMeasure);
  const toggleDrawRect  = useTraderStore(s => s.toggleDrawRect);

  return (
    <div style={{
      position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', gap: '4px',
      backgroundColor: '#111', border: '1px solid #2a2a2a', borderRadius: '8px',
      padding: '6px', zIndex: 30,
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="hline" title="水平線" active={isDrawingLine} disabled={!isLoaded} onClick={toggleDrawLine} />
        <LineStylePopup title="水平線の色・線種・太さ" disabled={!isLoaded} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="vline" title="垂直線" active={isDrawingVLine} disabled={!isLoaded} onClick={toggleDrawVLine} />
        <LineStylePopup title="垂直線の色・線種・太さ" disabled={!isLoaded} />
      </div>
      <ToolButton icon="ruler" title="ものさし" active={isMeasuring} disabled={!isLoaded} onClick={toggleMeasure} />
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="rect" title="四角形" active={isDrawingRect} disabled={!isLoaded} onClick={toggleDrawRect} />
        <RectStylePopup disabled={!isLoaded} />
      </div>
      <span style={{ height: '1px', margin: '2px 4px', backgroundColor: '#2a2a2a' }} />
      <MagnetButton disabled={!isLoaded} />
    </div>
  );
}
