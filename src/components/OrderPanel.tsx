import { useRef, useState, useEffect } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import type { OrderType, Side } from '../types';
import { pricePrecision } from '../lib/pips';
import { loadOrderPanelPos, saveOrderPanelPos, type PanelPos } from '../lib/orderPanelPos';
import { tfBtn } from './Controls';

const LOT_OPTIONS = [1_000, 3_000, 5_000, 10_000, 20_000, 50_000, 100_000];

// チャートクリックで値を取得するボタン（押すとピッキングモードに入る）
const pickBtn = (color: string, active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#141414' : active ? `${color}33` : '#1a1a1a',
  border: `1px solid ${disabled ? '#222' : active ? color : '#2a2a2a'}`,
  borderRadius: '3px', padding: '6px 8px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '14px',
});

const orderBtn = (bg: string, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#1a1a1a' : bg,
  color: disabled ? '#333' : '#fff',
  border: 'none', borderRadius: '3px',
  padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '17px', fontWeight: 700, letterSpacing: '0.05em',
});

// BUY/SELLの方向選択ボタン（選んだだけでは発注しない、tfBtnのactive/inactiveと同じ考え方の色付き版）
const sideBtn = (color: string, active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#1a1a1a' : active ? color : '#161616',
  color: disabled ? '#333' : active ? '#fff' : color,
  border: `1px solid ${disabled ? '#222' : color}`,
  borderRadius: '3px', padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '16px', fontWeight: 700, letterSpacing: '0.05em',
});

const rowLabel: React.CSSProperties = {
  width: '40px', flexShrink: 0, color: '#666', fontSize: '13px', fontWeight: 700,
};

const inputStyle = (color: string, borderColor: string, width: string): React.CSSProperties => ({
  backgroundColor: '#1a1a1a', color, border: `1px solid ${borderColor}`,
  borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width,
  fontVariantNumeric: 'tabular-nums',
});

// 発注パネル。再生ボタン（FloatingControls）・パレット（PalettePanel）と同じく、チャート上に
// 独立して浮かぶドラッグ可能なパネルにした。以前はメニューの中に色々詰め込みすぎて
// ゴチャゴチャしていたという指摘を受けて、「注文/数量/TP/SL/BUY・SELL」を行ごとに分離している。
// 位置はドラッグ終了時にlocalStorageへ保存し、次回開いた時も同じ位置に復元する
// （FloatingControls/PalettePanelはマウント中だけの記憶だが、こちらは明示的に「覚えておいて」
// という要望があったため別途永続化する）
export function OrderPanel() {
  const orderPanelOpen = useTraderStore(s => s.orderPanelOpen);
  const setOrderPanelOpen = useTraderStore(s => s.setOrderPanelOpen);
  const isLoaded      = useTraderStore(s => s.isLoaded);
  const candles       = useTraderStore(s => s.candles);
  const cursor        = useTraderStore(s => s.cursor);
  const balance       = useTraderStore(s => s.balance);
  const positions     = useTraderStore(s => s.positions);
  const orderType     = useTraderStore(s => s.orderType);
  const setOrderType  = useTraderStore(s => s.setOrderType);
  const draftPrice    = useTraderStore(s => s.draftPrice);
  const setDraftPrice = useTraderStore(s => s.setDraftPrice);
  const draftTP       = useTraderStore(s => s.draftTP);
  const setDraftTP    = useTraderStore(s => s.setDraftTP);
  const draftSL       = useTraderStore(s => s.draftSL);
  const setDraftSL    = useTraderStore(s => s.setDraftSL);
  const clearDraft    = useTraderStore(s => s.clearDraft);
  const togglePickTarget = useTraderStore(s => s.togglePickTarget);
  const pickTarget    = useTraderStore(s => s.pickTarget);
  const lots          = useTraderStore(s => s.lots);
  const setLots       = useTraderStore(s => s.setLots);
  const lotMode       = useTraderStore(s => s.lotMode);
  const setLotMode    = useTraderStore(s => s.setLotMode);
  const riskPercent   = useTraderStore(s => s.riskPercent);
  const setRiskPercent = useTraderStore(s => s.setRiskPercent);
  const submitOrder   = useTraderStore(s => s.submitOrder);
  const closeAll      = useTraderStore(s => s.closeAll);
  const chartRightMargin  = useTraderStore(s => s.chartRightMargin);
  const chartBottomMargin = useTraderStore(s => s.chartBottomMargin);

  const atEnd = candles.length > 0 && cursor >= candles.length - 1;
  const priceStep = candles.length > 0 ? 1 / 10 ** pricePrecision(candles[0].close) : 0.00001;
  const current = candles[cursor];
  const entryPriceForRisk = orderType === 'market' ? current?.close ?? null : draftPrice;
  const riskLotsPreview = (lotMode === 'risk' && draftSL !== null && entryPriceForRisk !== null && entryPriceForRisk !== draftSL)
    ? Math.round((balance * (riskPercent / 100)) / Math.abs(entryPriceForRisk - draftSL))
    : null;

  const [pos, setPos] = useState<PanelPos | null>(null);
  useEffect(() => { setPos(loadOrderPanelPos()); }, []);
  // BUY/SELLは即実行ボタンではなく「どちら向きで出すか」を選ぶだけにし、実際の発注は
  // 別途「注文執行」ボタンで確定する2段階操作にした（うっかりクリックでの誤発注を防ぐ狙い）
  const [selectedSide, setSelectedSide] = useState<Side>('BUY');
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
    const onUp = () => {
      if (dragRef.current) setPos(p => { if (p) saveOrderPanelPos(p); return p; });
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!orderPanelOpen) return null;

  const onHandleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement as HTMLDivElement;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent?.getBoundingClientRect();
    const origX = pos?.x ?? (rect.left - (parentRect?.left ?? 0));
    const origY = pos?.y ?? (rect.top - (parentRect?.top ?? 0));
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY, el: panel };
  };

  const handleExecute = () => {
    submitOrder(selectedSide);
    setOrderPanelOpen(false);
  };

  return (
    <div style={{
      position: 'absolute',
      // 初期位置は左下（FloatingControlsは右下、PalettePanelは右上で埋まっているため空いている場所）
      ...(pos
        ? { left: `${pos.x}px`, top: `${pos.y}px` }
        : { left: '16px', bottom: `${chartBottomMargin + 16}px` }),
      zIndex: 42,
      backgroundColor: 'rgba(13,13,13,0.95)', border: '1px solid #2a2a2a',
      borderRadius: '10px', padding: '10px 14px 14px 14px', boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
      userSelect: 'none', display: 'flex', flexDirection: 'column', gap: '10px',
      maxWidth: `calc(100% - ${chartRightMargin + 24}px)`,
    }}>
      <div
        onMouseDown={onHandleMouseDown}
        style={{ cursor: 'grab', color: '#555', fontSize: '13px', letterSpacing: '3px', lineHeight: 1, textAlign: 'center' }}
      >⠿⠿⠿</div>

      {/* 注文（成行/指値/逆指値） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel}>注文</span>
        <div style={{ display: 'flex', gap: '3px' }}>
          {([['market', '成行'], ['limit', '指値'], ['stop', '逆指値']] as [OrderType, string][]).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setOrderType(t)}
              disabled={!isLoaded || atEnd}
              style={tfBtn(orderType === t, !isLoaded || atEnd)}
            >{label}</button>
          ))}
        </div>
      </div>
      {orderType !== 'market' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={rowLabel} />
          <input
            type="number"
            placeholder="価格"
            value={draftPrice ?? ''}
            onChange={e => setDraftPrice(e.target.value === '' ? null : Number(e.target.value))}
            step={priceStep}
            style={inputStyle('#888', '#2a2a2a', '110px')}
          />
          <button
            onClick={() => togglePickTarget('price')}
            disabled={!isLoaded}
            style={pickBtn('#888', pickTarget === 'price', !isLoaded)}
          >📍</button>
        </div>
      )}

      {/* 数量（固定/リスク%） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel}>数量</span>
        <div style={{ display: 'flex', gap: '3px' }}>
          <button
            onClick={() => setLotMode('fixed')}
            disabled={!isLoaded || atEnd}
            style={tfBtn(lotMode === 'fixed', !isLoaded || atEnd)}
          >固定</button>
          <button
            onClick={() => setLotMode('risk')}
            disabled={!isLoaded || atEnd}
            style={tfBtn(lotMode === 'risk', !isLoaded || atEnd)}
          >リスク%</button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel} />
        {lotMode === 'fixed' ? (
          <select
            value={lots}
            onChange={e => setLots(Number(e.target.value))}
            disabled={!isLoaded || atEnd}
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '6px 8px', fontSize: '15px', cursor: 'pointer',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {LOT_OPTIONS.map(v => (
              <option key={v} value={v}>{v.toLocaleString()}</option>
            ))}
          </select>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="number"
              value={riskPercent}
              onChange={e => setRiskPercent(Number(e.target.value))}
              min={0.1} step={0.1}
              disabled={!isLoaded || atEnd}
              style={inputStyle('#888', '#2a2a2a', '60px')}
            />
            <span style={{ color: '#555', fontSize: '14px' }}>%</span>
            <span style={{ color: '#666', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
              {riskLotsPreview !== null ? `→ ${riskLotsPreview.toLocaleString()}通貨` : '→ SLを設定'}
            </span>
          </div>
        )}
      </div>

      {/* TP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel}>TP</span>
        <input
          type="number"
          placeholder="TP"
          value={draftTP ?? ''}
          onChange={e => setDraftTP(e.target.value === '' ? null : Number(e.target.value))}
          step={priceStep}
          style={inputStyle('#26a69a', '#1a3a35', '100px')}
        />
        <button
          onClick={() => togglePickTarget('tp')}
          disabled={!isLoaded}
          style={pickBtn('#26a69a', pickTarget === 'tp', !isLoaded)}
        >📍</button>
      </div>

      {/* SL */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel}>SL</span>
        <input
          type="number"
          placeholder="SL"
          value={draftSL ?? ''}
          onChange={e => setDraftSL(e.target.value === '' ? null : Number(e.target.value))}
          step={priceStep}
          style={inputStyle('#ef5350', '#3a1a1a', '100px')}
        />
        <button
          onClick={() => togglePickTarget('sl')}
          disabled={!isLoaded}
          style={pickBtn('#ef5350', pickTarget === 'sl', !isLoaded)}
        >📍</button>
        {(draftPrice !== null || draftTP !== null || draftSL !== null || pickTarget !== null) && (
          <button
            onClick={clearDraft}
            title="価格・TP・SLの下書きをクリア"
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '6px 10px', fontSize: '13px', cursor: 'pointer',
            }}
          >クリア</button>
        )}
      </div>

      {/* BUY / SELL（方向を選ぶだけ。即実行はしない） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
        <span style={rowLabel}>方向</span>
        <button
          onClick={() => setSelectedSide('BUY')}
          disabled={!isLoaded || atEnd}
          style={sideBtn('#1565c0', selectedSide === 'BUY', !isLoaded || atEnd)}
        >BUY</button>
        <button
          onClick={() => setSelectedSide('SELL')}
          disabled={!isLoaded || atEnd}
          style={sideBtn('#c62828', selectedSide === 'SELL', !isLoaded || atEnd)}
        >SELL</button>
      </div>

      {/* 注文執行（ここで確定。BUY/SELLで選んだ方向を実際に発注する） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel} />
        <button
          onClick={handleExecute}
          disabled={!isLoaded || atEnd}
          style={orderBtn(selectedSide === 'BUY' ? '#0d47a1' : '#b71c1c', !isLoaded || atEnd)}
        >注文執行</button>
        {positions.length > 1 && (
          <button onClick={closeAll} style={orderBtn('#333', false)}>全決済</button>
        )}
      </div>
    </div>
  );
}
