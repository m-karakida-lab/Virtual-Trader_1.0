import { useRef, useState, useEffect } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import { LINE_COLORS, TEXT_FONT_SIZES, WEEK_SEC, MONTH_SEC, type LineDash, type LineWidth, type TextBorderStyle, type TimeframeSec } from '../types';

const WIDTH_OPTIONS: LineWidth[] = [1, 2, 3, 4];
const DASH_OPTIONS: { v: LineDash; label: string }[] = [
  { v: 'solid', label: '実線' }, { v: 'dashed', label: '破線' }, { v: 'dotted', label: '点線' },
];
// 水平線の表示時間足。個別にON/OFFでき、デフォルトは全部ON（全時間足で表示）。
// 1HをOFFにすると5m/15mも連動して非表示になる（5m/15mは単独指定不可）
const HLINE_TF_OPTIONS: { v: TimeframeSec; label: string }[] = [
  { v: 3600, label: '1H' },
  { v: 14400, label: '4H' },
  { v: 86400, label: '1D' },
  { v: WEEK_SEC, label: '1W' },
  { v: MONTH_SEC, label: 'MN' },
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
  const isDrawingLine = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isDrawingRect = useTraderStore(s => s.isDrawingRect);
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingArrow = useTraderStore(s => s.isDrawingArrow);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const isDrawingText = useTraderStore(s => s.isDrawingText);
  const lineDraft = useTraderStore(s => s.lineDraft);
  const rectDraft = useTraderStore(s => s.rectDraft);
  const trendLineDraft = useTraderStore(s => s.trendLineDraft);
  const arrowDraft = useTraderStore(s => s.arrowDraft);
  const brushDraft = useTraderStore(s => s.brushDraft);
  const textDraft = useTraderStore(s => s.textDraft);
  const setLineDraft = useTraderStore(s => s.setLineDraft);
  const setRectDraft = useTraderStore(s => s.setRectDraft);
  const setTrendLineDraft = useTraderStore(s => s.setTrendLineDraft);
  const setArrowDraft = useTraderStore(s => s.setArrowDraft);
  const setBrushDraft = useTraderStore(s => s.setBrushDraft);
  const setTextDraft = useTraderStore(s => s.setTextDraft);
  const updateLine = useTraderStore(s => s.updateLine);
  // 水平線を選択編集中の時だけ使う、時間足ごとの表示ON/OFF（新規配置前のarmed状態には
  // 対応しない＝常に全時間足ONで配置し、必要なら配置後にここで個別にOFFする運用にしている）
  const selectedHLineHidden = useTraderStore(s =>
    selected?.kind === 'h' ? (s.lines.find(l => l.id === selected.id)?.hiddenTimeframes ?? []) : []
  );

  // 「書いてから見た目を直す」だけでなく「見た目を決めてから書く」需要があるため、図形を
  // 選択していなくても描画ツールのどれかが起動中（配置前）ならパレットを出す。その場合は
  // 選択中の図形ではなく、次に配置する時に使う各種Draft（lineDraft等）へ直接書き込む
  // （水平線・垂直線は同じlineDraftを共有——addLine/addVLine自体がそうなっているため）
  const armedKind = selected ? null
    : isDrawingLine ? 'h' as const
    : isDrawingVLine ? 'v' as const
    : isDrawingRect ? 'rect' as const
    : isDrawingTrendLine ? 'trend' as const
    : isDrawingArrow ? 'arrow' as const
    : isDrawingBrush ? 'brush' as const
    : isDrawingText ? 'text' as const
    : null;
  const kind = selected?.kind ?? armedKind;
  const isText = kind === 'text';
  const isBrush = kind === 'brush';

  const armedDraft = armedKind === 'text' ? textDraft
    : armedKind === 'brush' ? brushDraft
    : armedKind === 'rect' ? rectDraft
    : armedKind === 'trend' ? trendLineDraft
    : armedKind === 'arrow' ? arrowDraft
    : armedKind === 'h' || armedKind === 'v' ? lineDraft
    : null;
  const activeColor = armedDraft ? armedDraft.color : paletteStyle.color;
  const activeDash = armedDraft && 'dash' in armedDraft ? armedDraft.dash : paletteStyle.dash;
  const activeWidth = armedDraft && 'width' in armedDraft ? armedDraft.width : paletteStyle.width;
  const activeFontSize = armedDraft && 'fontSize' in armedDraft ? armedDraft.fontSize : paletteStyle.fontSize;
  const activeBorder = armedDraft && 'border' in armedDraft ? armedDraft.border : paletteStyle.border;

  type StylePatch = Partial<{ color: string; dash: LineDash; width: LineWidth; fontSize: typeof paletteStyle.fontSize; border: TextBorderStyle }>;
  const setStyle = (patch: StylePatch) => {
    if (!armedKind) { setPaletteStyle(patch); return; }
    if (armedKind === 'text') setTextDraft(patch);
    else if (armedKind === 'brush') setBrushDraft(patch);
    else if (armedKind === 'rect') setRectDraft(patch);
    else if (armedKind === 'trend') setTrendLineDraft(patch);
    else if (armedKind === 'arrow') setArrowDraft(patch);
    else setLineDraft(patch);
  };
  const setColor = (color: string) => setStyle({ color });
  const setDash = (dash: LineDash) => setStyle({ dash });
  const setWidth = (width: LineWidth) => setStyle({ width });
  const setFontSize = (fontSize: typeof paletteStyle.fontSize) => setStyle({ fontSize });
  const setBorder = (border: TextBorderStyle) => setStyle({ border });

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

  if (!paletteMode && !armedKind) return null;

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
                onClick={() => setFontSize(sz)}
                style={{
                  backgroundColor: activeFontSize === sz ? '#2a2a2a' : '#161616',
                  color: activeFontSize === sz ? '#e0e0e0' : '#666',
                  border: activeFontSize === sz ? '2px solid #42a5f5' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{sz}px</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '3px' }}>
            {TEXT_BORDER_OPTIONS.map(b => (
              <button
                key={b.v}
                onClick={() => setBorder(b.v)}
                style={{
                  backgroundColor: activeBorder === b.v ? '#2a2a2a' : '#161616',
                  color: activeBorder === b.v ? '#e0e0e0' : '#666',
                  border: activeBorder === b.v ? '1px solid #3a3a3a' : '1px solid #222',
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
                onClick={() => setDash(d.v)}
                style={{
                  backgroundColor: activeDash === d.v ? '#2a2a2a' : '#161616',
                  color: activeDash === d.v ? '#e0e0e0' : '#666',
                  border: activeDash === d.v ? '1px solid #3a3a3a' : '1px solid #222',
                  borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                }}
              >{d.label}</button>
            ))}
          </div>
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
          {selected?.kind === 'h' && (
            <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
              {HLINE_TF_OPTIONS.map(opt => {
                const isOn = !selectedHLineHidden.includes(opt.v);
                return (
                  <button
                    key={opt.v}
                    onClick={() => {
                      const next = isOn
                        ? [...selectedHLineHidden, opt.v]
                        : selectedHLineHidden.filter(v => v !== opt.v);
                      updateLine(selected.id, { hiddenTimeframes: next });
                    }}
                    title={opt.v === 3600 ? '1Hをオフにすると15m/5mも連動して非表示になります' : 'クリックでこの時間足での表示をON/OFF'}
                    style={{
                      backgroundColor: isOn ? '#2a2a2a' : '#161616',
                      color: isOn ? '#e0e0e0' : '#666',
                      border: isOn ? '2px solid #42a5f5' : '1px solid #222',
                      borderRadius: '3px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px', fontWeight: 700,
                    }}
                  >{opt.label}</button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
