import { useTraderStore } from '../store/useTraderStore';

// TradingView風の左端アイコンツールバー。クリックした瞬間にそのツールが有効化され、
// 続けてチャート上をクリック/ドラッグするだけで配置できる（配置後は自動的に解除される）。
// 実際の配置・スタイル変更・既存図形の一覧/削除は Controls.tsx の「描画」メニュー側が担う。
// 4画面時も1画面時と同じく、常に操作可能なメインパネル（CandleChart）に対して働く

const ICONS: Record<string, JSX.Element> = {
  hline: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="7" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  vline: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="7" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  ruler: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="9" width="18" height="6" rx="1" />
      <line x1="7" y1="9" x2="7" y2="12" />
      <line x1="11" y1="9" x2="11" y2="12" />
      <line x1="15" y1="9" x2="15" y2="12" />
      <line x1="19" y1="9" x2="19" y2="12" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="6" width="16" height="12" rx="1" />
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
        width: '32px', height: '32px',
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
      position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', gap: '2px',
      backgroundColor: '#111', border: '1px solid #2a2a2a', borderRadius: '6px',
      padding: '4px', zIndex: 30,
    }}>
      <ToolButton icon="hline" title="水平線" active={isDrawingLine} disabled={!isLoaded} onClick={toggleDrawLine} />
      <ToolButton icon="vline" title="垂直線" active={isDrawingVLine} disabled={!isLoaded} onClick={toggleDrawVLine} />
      <ToolButton icon="ruler" title="ものさし" active={isMeasuring} disabled={!isLoaded} onClick={toggleMeasure} />
      <ToolButton icon="rect" title="四角形" active={isDrawingRect} disabled={!isLoaded} onClick={toggleDrawRect} />
    </div>
  );
}
