import { useRef, useState, useEffect } from 'react';
import { useTraderStore } from '../store/useTraderStore';

// 再生・1コマ送り・1コマ戻しの大きなボタン群。ドラッグで画面内の好きな位置に移動できる。
export function FloatingControls() {
  const advance   = useTraderStore(s => s.advance);
  const stepBack  = useTraderStore(s => s.stepBack);
  const togglePlay = useTraderStore(s => s.togglePlay);
  const isPlaying = useTraderStore(s => s.isPlaying);
  const isLoaded  = useTraderStore(s => s.isLoaded);
  const cursor    = useTraderStore(s => s.cursor);
  const candles   = useTraderStore(s => s.candles);
  const chartRightMargin  = useTraderStore(s => s.chartRightMargin);
  const chartBottomMargin = useTraderStore(s => s.chartBottomMargin);

  const atEnd   = cursor >= candles.length - 1;
  const atStart = cursor <= 0;
  const disabled = !isLoaded;

  // null = デフォルト位置（右下）。ドラッグ後は px 座標で固定。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; el: HTMLDivElement } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      let x = d.origX + (e.clientX - d.startX);
      let y = d.origY + (e.clientY - d.startY);

      // チャート領域（offsetParent）の外、および価格軸・時間軸の上に出ないようクランプする
      const parent = d.el.offsetParent as HTMLElement | null;
      if (parent) {
        const { chartRightMargin: rm, chartBottomMargin: bm } = useTraderStore.getState();
        const maxX = Math.max(0, parent.clientWidth - d.el.offsetWidth - rm);
        const maxY = Math.max(0, parent.clientHeight - d.el.offsetHeight - bm);
        x = Math.min(Math.max(0, x), maxX);
        y = Math.min(Math.max(0, y), maxY);
      }
      setPos({ x, y });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onHandleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement as HTMLDivElement;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent?.getBoundingClientRect();
    const origX = pos?.x ?? (rect.left - (parentRect?.left ?? 0));
    const origY = pos?.y ?? (rect.top - (parentRect?.top ?? 0));
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY, el: panel };
  };

  return (
    <div style={{
      position: 'absolute',
      ...(pos
        ? { left: `${pos.x}px`, top: `${pos.y}px` }
        : { right: `${24 + chartRightMargin}px`, bottom: `${24 + chartBottomMargin}px` }),
      zIndex: 40,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      backgroundColor: 'rgba(13,13,13,0.92)', border: '1px solid #2a2a2a',
      borderRadius: '12px', padding: '6px 10px 10px 10px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.55)', userSelect: 'none',
    }}>
      <div
        onMouseDown={onHandleMouseDown}
        style={{ cursor: 'grab', color: '#555', fontSize: '14px', padding: '2px 0 6px 0', letterSpacing: '3px', lineHeight: 1 }}
      >⠿⠿⠿</div>
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={() => stepBack()}
          disabled={disabled || atStart}
          style={bigBtn(disabled || atStart)}
          title="1コマ戻る"
        >⏮</button>
        <button
          onClick={togglePlay}
          disabled={disabled || atEnd}
          style={bigBtn(disabled || atEnd, true)}
          title={isPlaying ? '一時停止' : '再生'}
        >{isPlaying ? '⏸' : '▶'}</button>
        <button
          onClick={() => advance()}
          disabled={disabled || atEnd || isPlaying}
          style={bigBtn(disabled || atEnd || isPlaying)}
          title="1コマ進む"
        >⏭</button>
      </div>
    </div>
  );
}

const bigBtn = (disabled: boolean, primary = false): React.CSSProperties => ({
  width: '52px', height: '52px', borderRadius: '50%',
  backgroundColor: disabled ? '#161616' : primary ? '#1565c0' : '#222',
  color: disabled ? '#3a3a3a' : '#fff',
  border: disabled ? '1px solid #222' : primary ? '1px solid #1976d2' : '1px solid #333',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center',
});
