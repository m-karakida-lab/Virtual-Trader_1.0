import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import { TIMEFRAMES } from '../types';
import { loadMemoWin, saveMemoWin, type MemoWinRect } from '../lib/tradeMemoWin';

const MIN_W = 240;
const MIN_H = 140;
const HEADER_H = 32;

// 画面外に出て掴めなくならないよう、ヘッダーが必ず見える範囲へ収める
function clampToViewport(r: MemoWinRect): MemoWinRect {
  const w = Math.min(Math.max(MIN_W, r.w), window.innerWidth);
  const h = Math.min(Math.max(MIN_H, r.h), window.innerHeight);
  return {
    w, h,
    x: Math.min(Math.max(0, r.x), Math.max(0, window.innerWidth - w)),
    y: Math.min(Math.max(0, r.y), Math.max(0, window.innerHeight - HEADER_H)),
  };
}

// トレード日誌メモのポップアップ窓。取引履歴パネルの行のメモボタンで開き、ヘッダーのドラッグで
// 移動、右下の角で大きさ変更（ネイティブresize）ができ、位置と大きさは次回も再現する
export function TradeMemoWindow() {
  const memoTradeId = useTraderStore(s => s.memoTradeId);
  const setMemoTradeId = useTraderStore(s => s.setMemoTradeId);
  const closedTrades = useTraderStore(s => s.closedTrades);
  const setTradeMemo = useTraderStore(s => s.setTradeMemo);
  const chartLayout = useTraderStore(s => s.chartLayout);
  const mainTimeframeSec = useTraderStore(s => s.timeframeSec);
  const quad3Timeframes = useTraderStore(s => s.quad3Timeframes);
  const quad4Timeframes = useTraderStore(s => s.quad4Timeframes);
  const insertRef = useRef<((text: string) => void) | null>(null);
  const trade = memoTradeId === null ? undefined : closedTrades.find(t => t.id === memoTradeId);

  const [rect, setRect] = useState<MemoWinRect>(() => clampToViewport(loadMemoWin()));
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setRect(r => clampToViewport({ ...r, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
    };
    const onUp = () => {
      if (dragRef.current) saveMemoWin(rectRef.current);
      dragRef.current = null;
    };
    const onWinResize = () => setRect(r => clampToViewport(r));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onWinResize);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onWinResize);
    };
  }, []);

  // 右下の角のドラッグによる大きさ変更はDOM側で起きるので、ResizeObserverで拾って記憶する
  const open = trade !== undefined;
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w === rectRef.current.w && h === rectRef.current.h) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = { ...rectRef.current, w, h };
        setRect(next);
        saveMemoWin(next);
      }, 200);
    });
    ro.observe(el);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, [open]);

  if (!trade) return null;
  // 表示中パネルの時間足を大きい順に並べた見出しテンプレート（1画面はメインの1つだけ）
  const shown = chartLayout === '1' ? [mainTimeframeSec]
    : chartLayout === '3' ? quad3Timeframes.slice(0, 3) : quad4Timeframes;
  const template = [...new Set(shown)].sort((a, b) => b - a)
    .map(sec => `■${TIMEFRAMES.find(t => t.sec === sec)?.label ?? sec}\n\n`).join('\n');
  const sorted = [...closedTrades].sort((a, b) => a.closeTime - b.closeTime);
  const no = sorted.findIndex(t => t.id === trade.id) + 1;

  return (
    <div
      ref={elRef}
      style={{
        position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        minWidth: MIN_W, minHeight: MIN_H, resize: 'both', overflow: 'hidden',
        zIndex: 110, display: 'flex', flexDirection: 'column',
        backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      }}
    >
      <div
        onMouseDown={e => {
          // preventDefaultはテキスト選択を防ぐためだが、フォーカスも奪えなくなるので明示的にblurして保存させる
          (document.activeElement as HTMLElement | null)?.blur();
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.x, oy: rect.y };
          e.preventDefault();
        }}
        style={{
          height: HEADER_H, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 8px 0 12px', cursor: 'move', userSelect: 'none',
          backgroundColor: '#1a1a1a', borderBottom: '1px solid #2a2a2a', fontSize: '13px', color: '#aaa',
        }}
      >
        <span>
          <span style={{ color: '#e0e0e0', fontWeight: 700 }}>トレード #{no}</span>
          <span style={{ marginLeft: '8px', color: trade.side === 'BUY' ? '#26a69a' : '#ef5350', fontWeight: 700 }}>{trade.side}</span>
          <span style={{ marginLeft: '8px' }}>{trade.pnl >= 0 ? '+' : ''}{Math.round(trade.pnl).toLocaleString()}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={() => insertRef.current?.(template)}
          title="表示中パネルの時間足ごとの見出しをカーソル位置に挿入"
          style={{ background: 'none', border: '1px solid #444', borderRadius: '3px', color: '#aaa', cursor: 'pointer', fontSize: '11px', padding: '1px 6px' }}
        >テンプレ</button>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setMemoTradeId(null)}
          title="閉じる（入力中の内容は保存されます）"
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
        >×</button>
        </span>
      </div>
      <MemoEditor key={trade.id} value={trade.memo ?? ''} onCommit={v => setTradeMemo(trade.id, v)} insertRef={insertRef} />
    </div>
  );
}

// 1打鍵ごとにstoreへ書くと取引履歴の集計・MAE/MFE再計算が走って重いので、手元のstateで編集して
// フォーカスが外れた時・閉じる時・別の取引に切り替わる時だけコミットする
function MemoEditor({ value, onCommit, insertRef }: {
  value: string; onCommit: (v: string) => void; insertRef: { current: ((text: string) => void) | null };
}) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const committedRef = useRef(value);
  const commit = () => {
    if (draftRef.current !== committedRef.current) {
      committedRef.current = draftRef.current;
      onCommit(draftRef.current);
    }
  };
  useEffect(() => commit, []); // eslint-disable-line react-hooks/exhaustive-deps
  const taRef = useRef<HTMLTextAreaElement>(null);
  // カーソル位置（未フォーカスなら末尾）へ挿入し、挿入直後にカーソルを置く
  insertRef.current = text => {
    const ta = taRef.current;
    const d = draftRef.current;
    const pos = ta ? ta.selectionStart : d.length;
    const end = ta ? ta.selectionEnd : d.length;
    setDraft(d.slice(0, pos) + text + d.slice(end));
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(pos + text.length, pos + text.length); });
  };
  return (
    <textarea
      ref={taRef}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      placeholder="エントリー理由・反省など（フォーカスを外すと保存）"
      style={{
        flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none', border: 'none', outline: 'none',
        backgroundColor: '#111', color: '#e0e0e0', padding: '8px 10px', fontSize: '13px',
        fontFamily: 'inherit', lineHeight: 1.5,
      }}
    />
  );
}
