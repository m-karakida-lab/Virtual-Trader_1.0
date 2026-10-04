import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import type { LineSelection, MagnetMode } from '../types';
import { pricePrecision } from '../lib/pips';
import { fmtVTime } from './Controls';

// TradingView風のアイコンツールバー。クリックした瞬間にそのツールが有効化され、
// 続けてチャート上をクリック/ドラッグするだけで配置できる（配置後は自動的に解除される）。
// 色・線種・太さの編集は右上のPalettePanel（パレットモード）が一手に担う。
// 既存図形（水平線/垂直線/四角形/トレンドライン/矢印/ブラシ/テキスト）の一覧・選択・削除は
// このツールバー下部の「一覧」ポップアップが担う。
// 4画面時も1画面時と同じく、常に操作可能なメインパネル（CandleChart）に対して働く。
// 自身は絶対配置を持たず、App.tsx側でチャート領域の左に確保した専用列に配置される

const ICONS: Record<string, JSX.Element> = {
  hline: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="12" x2="21" y2="12" />
      {/* ドットは線の端寄りではなく中央に置くこと。端寄りだと矢じりに見えて
          矢印アイコンと誤認される */}
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  vline: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
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
  channel: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="15" x2="15" y2="4" />
      <line x1="9" y1="20" x2="21" y2="9" />
      <circle cx="3" cy="15" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="4" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="19" x2="19" y2="5" />
      <polygon points="19,12 19,5 12,5" fill="currentColor" stroke="none" />
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
  // 描画管理（既存図形の一覧）。箇条書きリストで表す
  list: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <line x1="9" y1="6" x2="21" y2="6" strokeLinecap="round" />
      <line x1="9" y1="12" x2="21" y2="12" strokeLinecap="round" />
      <line x1="9" y1="18" x2="21" y2="18" strokeLinecap="round" />
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
// マグネットの強さ選択と同じ見た目・操作感に揃える。ボタン文言は何のON/OFFか分かるよう、
// subject（例:「価格ラベル」）を含めて明示する
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

const chipStyle = (isSel: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
  backgroundColor: isSel ? '#222' : '#161616',
  border: isSel ? '1px solid #444' : '1px solid #2a2a2a',
  borderRadius: '3px', padding: '3px 4px 3px 8px', fontSize: '15px', color: '#888',
  fontVariantNumeric: 'tabular-nums',
});

const chipDotStyle = (color: string, round: boolean): React.CSSProperties => ({
  width: '8px', height: '8px', borderRadius: round ? '50%' : 0, backgroundColor: color, flexShrink: 0,
});

const chipRemoveStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#555',
  cursor: 'pointer', fontSize: '16px', padding: '0 4px', lineHeight: 1,
};

// 既存の描画物（水平線/垂直線/四角形/トレンドライン/ブラシ/テキスト）を種類ごとに縦並びで
// 一覧表示し、クリックで選択・×ボタンで削除できるポップアップ。件数が多くても
// maxHeight+overflowYでスクロールに収める（下部バーの項目を押し出さないための移設なので、
// ここでも横に溢れさせず縦スクロールにする）
function DrawnObjectsPopup({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // ポップアップは位置決めの基準をposition:fixedにする。App.tsx側でこのツールバーを囲む
  // フレックス行がoverflow:hiddenのため、position:absoluteのままだと画面下寄りのボタンから
  // 開いた時にポップアップ自身の高さ制限（maxHeight+overflowY）より先にその祖先で見た目が
  // 切り取られてしまい、スクロールバーごと消える（図形が多い時に起きる）
  const [anchor, setAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const lines = useTraderStore(s => s.lines);
  const vlines = useTraderStore(s => s.vlines);
  const rects = useTraderStore(s => s.rects);
  const trendLines = useTraderStore(s => s.trendLines);
  const channels = useTraderStore(s => s.channels);
  const arrows = useTraderStore(s => s.arrows);
  const brushes = useTraderStore(s => s.brushes);
  const texts = useTraderStore(s => s.texts);
  const selected = useTraderStore(s => s.selected);
  const selectLine = useTraderStore(s => s.selectLine);
  const removeLine = useTraderStore(s => s.removeLine);
  const removeVLine = useTraderStore(s => s.removeVLine);
  const removeRect = useTraderStore(s => s.removeRect);
  const removeTrendLine = useTraderStore(s => s.removeTrendLine);
  const removeChannel = useTraderStore(s => s.removeChannel);
  const removeArrow = useTraderStore(s => s.removeArrow);
  const removeBrush = useTraderStore(s => s.removeBrush);
  const removeText = useTraderStore(s => s.removeText);
  const centerOnTime = useTraderStore(s => s.centerOnTime);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const isEmpty = lines.length === 0 && vlines.length === 0 && rects.length === 0
    && trendLines.length === 0 && channels.length === 0 && arrows.length === 0 && brushes.length === 0 && texts.length === 0;

  const openPopup = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 8;
      setAnchor({ left: rect.right + margin, top: rect.top, maxHeight: window.innerHeight - rect.top - margin });
    }
    setOpen(o => !o);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={openPopup}
        disabled={disabled}
        title="描画の管理（一覧・選択・削除）"
        style={{
          width: '40px', height: '40px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: disabled ? 'transparent' : open ? '#2a2a2a' : 'transparent',
          color: disabled ? '#333' : open ? '#42a5f5' : '#888',
          border: 'none', borderRadius: '4px',
          cursor: disabled ? 'not-allowed' : 'pointer', padding: 0,
        }}
      >
        {ICONS.list}
      </button>
      {open && anchor && (
        <div className="vt-dark-scroll" style={{
          position: 'fixed', left: anchor.left, top: anchor.top,
          backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
          padding: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 60,
          display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '200px',
          maxHeight: `${anchor.maxHeight}px`, overflowY: 'auto',
        }}>
          {isEmpty && <span style={{ color: '#555', fontSize: '14px', padding: '4px 0' }}>描画物はありません</span>}

          {lines.map(line => {
            const isSel = selected?.kind === 'h' && selected.id === line.id;
            const sel: LineSelection = { kind: 'h', id: line.id };
            return (
              <span key={`h${line.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(line.color, true)} />
                {line.price.toFixed(pricePrecision(line.price))}
                <button onClick={e => { e.stopPropagation(); removeLine(line.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {vlines.map(v => {
            const isSel = selected?.kind === 'v' && selected.id === v.id;
            const sel: LineSelection = { kind: 'v', id: v.id };
            return (
              <span key={`v${v.id}`} onClick={() => { selectLine(isSel ? null : sel); centerOnTime(v.time); }} style={chipStyle(isSel)}>
                <span style={chipDotStyle(v.color, false)} />
                {fmtVTime(v.time)}
                <button onClick={e => { e.stopPropagation(); removeVLine(v.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {rects.map((r, i) => {
            const isSel = selected?.kind === 'rect' && selected.id === r.id;
            const sel: LineSelection = { kind: 'rect', id: r.id };
            return (
              <span key={`r${r.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(r.color, false)} />
                四角{i + 1}
                <button onClick={e => { e.stopPropagation(); removeRect(r.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {trendLines.map((tl, i) => {
            const isSel = selected?.kind === 'trend' && selected.id === tl.id;
            const sel: LineSelection = { kind: 'trend', id: tl.id };
            return (
              <span key={`tl${tl.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(tl.color, true)} />
                トレンド{i + 1}
                <button onClick={e => { e.stopPropagation(); removeTrendLine(tl.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {channels.map((ch, i) => {
            const isSel = selected?.kind === 'channel' && selected.id === ch.id;
            const sel: LineSelection = { kind: 'channel', id: ch.id };
            return (
              <span key={`ch${ch.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(ch.color, true)} />
                チャネル{i + 1}
                <button onClick={e => { e.stopPropagation(); removeChannel(ch.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {arrows.map((ar, i) => {
            const isSel = selected?.kind === 'arrow' && selected.id === ar.id;
            const sel: LineSelection = { kind: 'arrow', id: ar.id };
            return (
              <span key={`ar${ar.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(ar.color, true)} />
                矢印{i + 1}
                <button onClick={e => { e.stopPropagation(); removeArrow(ar.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {brushes.map((b, i) => {
            const isSel = selected?.kind === 'brush' && selected.id === b.id;
            const sel: LineSelection = { kind: 'brush', id: b.id };
            return (
              <span key={`b${b.id}`} onClick={() => selectLine(isSel ? null : sel)} style={chipStyle(isSel)}>
                <span style={chipDotStyle(b.color, true)} />
                ブラシ{i + 1}
                <button onClick={e => { e.stopPropagation(); removeBrush(b.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}

          {texts.map(t => {
            const isSel = selected?.kind === 'text' && selected.id === t.id;
            const sel: LineSelection = { kind: 'text', id: t.id };
            return (
              <span key={`t${t.id}`} onClick={() => selectLine(isSel ? null : sel)} style={{ ...chipStyle(isSel), maxWidth: '220px' }}>
                <span style={chipDotStyle(t.color, true)} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span>
                <button onClick={e => { e.stopPropagation(); removeText(t.id); }} style={chipRemoveStyle}>×</button>
              </span>
            );
          })}
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
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingChannel = useTraderStore(s => s.isDrawingChannel);
  const isDrawingArrow = useTraderStore(s => s.isDrawingArrow);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const isDrawingText  = useTraderStore(s => s.isDrawingText);
  const toggleDrawLine  = useTraderStore(s => s.toggleDrawLine);
  const toggleDrawVLine = useTraderStore(s => s.toggleDrawVLine);
  const toggleMeasure   = useTraderStore(s => s.toggleMeasure);
  const toggleDrawRect  = useTraderStore(s => s.toggleDrawRect);
  const toggleDrawTrendLine = useTraderStore(s => s.toggleDrawTrendLine);
  const toggleDrawChannel = useTraderStore(s => s.toggleDrawChannel);
  const toggleDrawArrow = useTraderStore(s => s.toggleDrawArrow);
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
      <ToolButton icon="channel" title="平行チャネル（ドラッグで基準線→もう1クリックで幅を決定）" active={isDrawingChannel} disabled={!isLoaded} onClick={toggleDrawChannel} />
      <ToolButton icon="arrow" title="矢印（特定の足を指し示す）" active={isDrawingArrow} disabled={!isLoaded} onClick={toggleDrawArrow} />
      <ToolButton icon="brush" title="ブラシ" active={isDrawingBrush} disabled={!isLoaded} onClick={toggleDrawBrush} />
      <ToolButton icon="text" title="テキスト" active={isDrawingText} disabled={!isLoaded} onClick={toggleDrawText} />
      <DrawnObjectsPopup disabled={!isLoaded} />
      {/* 下の5アイコン（一覧/ジャンプ/連続描画/マグネット/表示切替）は、「描画系ツール＋一覧」
          「動作モードの切替（ジャンプ/連続描画/マグネット）」「全体の表示切替」の3グループに
          まとめ、区切り線は2本だけにしてコントラストを上げている。幅はToolButton本体と同じ
          40pxに固定する——デフォルトのstretchだと、矢印付きの行（水平線の価格ラベル切替等、
          ToolButtonの右にさらに矢印ボタンが並ぶ行）の幅に合わせて伸びてしまい、
          アイコン部分だけより右にはみ出す。
          alignSelfはcenterではなくflex-startにすること——ToolButton自体は明示的な
          width指定によりstretchされず常にflex-start（左端＝アイコン本体の位置）に
          揃うため、区切り線もcenterにすると数px右へズレてアイコンの真下から外れる */}
      <span style={{ height: '1px', width: '40px', alignSelf: 'flex-start', margin: '4px 0', backgroundColor: '#3a3a3a' }} />
      <ToolButton
        icon="jumpSync"
        title={chartLayout !== '1' ? 'ジャンプモード（有効化後、いずれかのパネルで足をクリックすると他の枠がその時刻へ移動します）' : 'ジャンプモード（3画面/4画面表示でのみ使えます）'}
        active={isJumpSync}
        disabled={!isLoaded || chartLayout === '1'}
        onClick={toggleJumpSync}
      />
      <ToolButton icon="lock" title="連続描画（配置してもツールを維持する）" active={continuousDrawing} disabled={!isLoaded} onClick={toggleContinuousDrawing} />
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <ToolButton icon="magnet" title="マグネット（足のOHLCに吸着）" active={magnetMode !== 'off'} disabled={!isLoaded} onClick={toggleMagnet} />
        <MagnetStrengthPopup disabled={!isLoaded} />
      </div>
      <span style={{ height: '1px', width: '40px', alignSelf: 'flex-start', margin: '4px 0', backgroundColor: '#3a3a3a' }} />
      <ToolButton icon={overlaysHidden ? 'eyeOff' : 'eye'} title="インジケータ・描画を全て非表示（データは消えない）" active={overlaysHidden} disabled={!isLoaded} onClick={toggleOverlaysHidden} />
    </div>
  );
}
