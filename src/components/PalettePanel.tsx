import { useRef, useState, useEffect } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import { LINE_COLORS, TEXT_FONT_SIZES, type LineDash, type LineWidth, type TextBorderStyle } from '../types';

const WIDTH_OPTIONS: LineWidth[] = [1, 2, 3, 4];
const DASH_OPTIONS: { v: LineDash; label: string }[] = [
  { v: 'solid', label: '実線' }, { v: 'dashed', label: '破線' }, { v: 'dotted', label: '点線' },
];
const TEXT_BORDER_OPTIONS: { v: TextBorderStyle; label: string }[] = [
  { v: 'solid', label: '実線' }, { v: 'dashed', label: '破線' }, { v: 'dotted', label: '点線' }, { v: 'none', label: '枠なし' },
];

// パレットモード中だけ表示する常設フローティングウィンドウ。ここで選んだ色・線種・太さは
// 「次に選択（編集モードに入れる）した図形」へ即座に反映される（store側のselectLineが担う）。
// ドラッグでの移動はFloatingControlsと同じ仕組み（位置はマウント中だけ保持、保存はしない）
export function PalettePanel() {
  const paletteMode  = useTraderStore(s => s.paletteMode);
  const paletteStyle = useTraderStore(s => s.paletteStyle);
  const setPaletteStyle = useTraderStore(s => s.setPaletteStyle);
  const chartRightMargin  = useTraderStore(s => s.chartRightMargin);
  const selected = useTraderStore(s => s.selected);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const brushDraft = useTraderStore(s => s.brushDraft);
  const setBrushDraft = useTraderStore(s => s.setBrushDraft);
  const isText = selected?.kind === 'text';
  // ブラシは「書いてから太さを直す」だけでなく「太さを決めてから書く」需要があるため、
  // 図形を選択していなくてもブラシツールが起動中（配置前）ならパレットを出し、
  // その場合は選択中の図形ではなく次に描く時に使うbrushDraftへ直接書き込む
  const isArmedBrush = isDrawingBrush && !selected;
  const isBrush = selected?.kind === 'brush' || isArmedBrush;
  const activeColor = isArmedBrush ? brushDraft.color : paletteStyle.color;
  const activeWidth = isArmedBrush ? brushDraft.width : paletteStyle.width;
  const setColor = (color: string) => isArmedBrush ? setBrushDraft({ color }) : setPaletteStyle({ color });
  const setWidth = (width: typeof paletteStyle.width) => isArmedBrush ? setBrushDraft({ width }) : setPaletteStyle({ width });

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; el: HTMLDivElement } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      let x = d.origX + (e.clientX - d.startX);
      let y = d.origY + (e.clientY - d.startY);
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

  if (!paletteMode && !isArmedBrush) return null;

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
      // 初期位置は右上（価格軸の左）にする。DrawToolbar（左端・縦方向中央寄せ）は
      // コンテナの高さ次第で上寄りにも来ることがあり、左側だとこのパネルの方が
      // zIndexが高いためツールボタンへのクリックを奪ってしまう。右上なら確実に空いている
      ...(pos
        ? { left: `${pos.x}px`, top: `${pos.y}px` }
        : { right: `${chartRightMargin + 16}px`, top: '16px' }),
      zIndex: 41,
      backgroundColor: 'rgba(13,13,13,0.95)', border: '1px solid #2a2a2a',
      borderRadius: '10px', padding: '10px 12px', boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
      userSelect: 'none', display: 'flex', flexDirection: 'column', gap: '10px',
      maxWidth: `calc(100% - ${chartRightMargin + 24}px)`,
    }}>
      <div
        onMouseDown={onHandleMouseDown}
        style={{ cursor: 'grab', color: '#555', fontSize: '13px', letterSpacing: '3px', lineHeight: 1, textAlign: 'center' }}
      >⠿⠿⠿</div>
      <div style={{ display: 'flex', gap: '4px' }}>
        {LINE_COLORS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            style={{
              width: '20px', height: '20px', borderRadius: '50%', backgroundColor: c,
              border: activeColor === c ? '2px solid #fff' : '2px solid transparent',
              cursor: 'pointer', padding: 0,
            }}
          />
        ))}
      </div>
      {isText ? (
        <>
          <div style={{ display: 'flex', gap: '3px' }}>
            {TEXT_FONT_SIZES.map(sz => (
              <button
                key={sz}
                onClick={() => setPaletteStyle({ fontSize: sz })}
                style={{
                  backgroundColor: paletteStyle.fontSize === sz ? '#2a2a2a' : '#161616',
                  color: paletteStyle.fontSize === sz ? '#e0e0e0' : '#666',
                  border: paletteStyle.fontSize === sz ? '2px solid #42a5f5' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{sz}px</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '3px' }}>
            {TEXT_BORDER_OPTIONS.map(b => (
              <button
                key={b.v}
                onClick={() => setPaletteStyle({ border: b.v })}
                style={{
                  backgroundColor: paletteStyle.border === b.v ? '#2a2a2a' : '#161616',
                  color: paletteStyle.border === b.v ? '#e0e0e0' : '#666',
                  border: paletteStyle.border === b.v ? '1px solid #3a3a3a' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{b.label}</button>
            ))}
          </div>
        </>
      ) : isBrush ? (
        <div style={{ display: 'flex', gap: '3px' }}>
          {WIDTH_OPTIONS.map(w => (
            <button
              key={w}
              onClick={() => setWidth(w)}
              style={{
                backgroundColor: activeWidth === w ? '#2a2a2a' : '#161616',
                color: activeWidth === w ? '#e0e0e0' : '#666',
                border: activeWidth === w ? '2px solid #42a5f5' : '1px solid #222',
                borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
              }}
            >{w}px</button>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '3px' }}>
            {DASH_OPTIONS.map(d => (
              <button
                key={d.v}
                onClick={() => setPaletteStyle({ dash: d.v })}
                style={{
                  backgroundColor: paletteStyle.dash === d.v ? '#2a2a2a' : '#161616',
                  color: paletteStyle.dash === d.v ? '#e0e0e0' : '#666',
                  border: paletteStyle.dash === d.v ? '1px solid #3a3a3a' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{d.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '3px' }}>
            {WIDTH_OPTIONS.map(w => (
              <button
                key={w}
                onClick={() => setPaletteStyle({ width: w })}
                style={{
                  backgroundColor: paletteStyle.width === w ? '#2a2a2a' : '#161616',
                  color: paletteStyle.width === w ? '#e0e0e0' : '#666',
                  border: paletteStyle.width === w ? '2px solid #42a5f5' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{w}px</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
