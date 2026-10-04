import { useRef, useState, useEffect } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import type { OrderType, Side } from '../types';
import { pricePrecision } from '../lib/pips';
import { captureChartAreaCanvas, encodeCanvasFitted } from '../lib/screenshot';
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

// 値（入力値・ボタンのテキスト）と同じ太さ・大きさだと視線の置きどころが探しづらいという
// 指摘を受け、構造ラベル側を一段暗く軽くして明度差だけで階層をつけた。最初11pxまで
// 縮めたところ「小さすぎる」という指摘を受け、サイズは元の13pxへ戻し色と太さだけで
// 階層をつける形に調整した
const rowLabel: React.CSSProperties = {
  width: '40px', flexShrink: 0, color: '#6e6e6e', fontSize: '13px', fontWeight: 500,
};

const inputStyle = (color: string, borderColor: string, width: string): React.CSSProperties => ({
  backgroundColor: '#1a1a1a', color, border: `1px solid ${borderColor}`,
  borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width,
  fontVariantNumeric: 'tabular-nums',
});

// 発注パネル。パレット（PalettePanel）と同じく、チャート上に独立して浮かぶドラッグ可能な
// パネルにした。以前はメニューの中に色々詰め込みすぎてゴチャゴチャしていたという指摘を
// 受けて、「注文/数量/TP/SL/BUY・SELL」を行ごとに分離している。
// 位置はドラッグ終了時にlocalStorageへ保存し、次回開いた時も同じ位置に復元する
// （PalettePanelはマウント中だけの記憶だが、こちらは明示的に「覚えておいて」という
// 要望があったため別途永続化する）
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
  const lastOrderRatiosByKey = useTraderStore(s => s.lastOrderRatiosByKey);
  const togglePickTarget = useTraderStore(s => s.togglePickTarget);
  const pickTarget    = useTraderStore(s => s.pickTarget);
  const lots          = useTraderStore(s => s.lots);
  const setLots       = useTraderStore(s => s.setLots);
  const lotMode       = useTraderStore(s => s.lotMode);
  const setLotMode    = useTraderStore(s => s.setLotMode);
  const riskPercent   = useTraderStore(s => s.riskPercent);
  const setRiskPercent = useTraderStore(s => s.setRiskPercent);
  const submitOrder   = useTraderStore(s => s.submitOrder);
  const error         = useTraderStore(s => s.error);
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

  // パネルを開いた瞬間、および注文種別(成行/指値/逆指値)・方向(BUY/SELL)を切り替えた瞬間に、
  // その組み合わせの前回発注で価格/TP/SLがエントリー価格から何%離れていたかを「今の現在値」に
  // 適用し直して仮入力する（前回と同じ距離感で発注することが多いはず、という想定で毎回の
  // 手入力の手間を減らす）。BUY/SELLや注文種別を切り替えるたびに、その組み合わせ専用の
  // 値へ置き換わる（＝既存の入力値も上書きする。組み合わせを切り替える操作自体が
  // 「その組み合わせの値を見たい」という意思表示なので、他の組み合わせで入れた値を
  // 引きずらない）。その組み合わせの発注履歴が無ければ何もしない（今の入力値のまま）
  useEffect(() => {
    if (!orderPanelOpen) return;
    const ratioKey = `${orderType}:${selectedSide}`;
    const ratios = lastOrderRatiosByKey[ratioKey];
    if (!ratios) return;
    const { candles: cs, cursor: cur } = useTraderStore.getState();
    const current = cs[cur]?.close;
    if (current === undefined) return;
    const prec = pricePrecision(current);
    const round = (v: number) => Number(v.toFixed(prec));
    // tpRatio/slRatioは元々「エントリー価格からの距離」として記録している（submitOrder参照）。
    // 指値・逆指値では実際のエントリーは現在値ではなくdraftPriceになるため、TP/SLも現在値
    // ではなく「今回再現するエントリー価格」を基準に計算しないとRR（損益比）が保たれない。
    // 以前は無条件に現在値を基準にしていたため、指値/逆指値でエントリーと現在値が離れている
    // ほどRRが大きくズレる不具合になっていた（例: 1:1のつもりが1:6になる）
    const priceRatio = ratios.priceRatio;
    const willUsePriceRatio = orderType !== 'market' && priceRatio !== null;
    const entryBase = willUsePriceRatio ? current * (1 + priceRatio) : current;
    setDraftPrice(willUsePriceRatio ? round(entryBase) : null);
    setDraftTP(ratios.tpRatio !== null ? round(entryBase * (1 + ratios.tpRatio)) : null);
    setDraftSL(ratios.slRatio !== null ? round(entryBase * (1 + ratios.slRatio)) : null);
  }, [orderPanelOpen, orderType, selectedSide, lastOrderRatiosByKey, setDraftPrice, setDraftTP, setDraftSL]);

  if (!orderPanelOpen) return null;

  const onHandleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement as HTMLDivElement;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent?.getBoundingClientRect();
    const origX = pos?.x ?? (rect.left - (parentRect?.left ?? 0));
    const origY = pos?.y ?? (rect.top - (parentRect?.top ?? 0));
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY, el: panel };
  };

  const handleExecute = async () => {
    // TP/SLを入れている時だけ、発注前（R:R表示が出ている間）の画面をトレード日誌用に撮る。
    // submitOrderが下書きTP/SLを消すため、画面の取り込みだけは必ずその前に済ませる。
    // 重い画像のエンコードは発注後に裏で行い、できたら取引へ付ける（発注を待たせない）
    const canvas = draftTP !== null || draftSL !== null ? await captureChartAreaCanvas() : null;
    const before = useTraderStore.getState();
    const target = before.orderType === 'market'
      ? { kind: 'position' as const, id: before.nextId }
      : { kind: 'order' as const, id: before.nextOrderId };
    // 失敗時（残高不足・TP/SLの向きが矛盾等）はパネルを閉じない。閉じてしまうと
    // エラー内容を見ながら入力を直せないため（成功時のみ閉じる）
    if (!submitOrder(selectedSide)) return;
    setOrderPanelOpen(false);
    if (canvas) {
      void encodeCanvasFitted(canvas).then(img => {
        if (img) useTraderStore.getState().attachRrImage(target, img);
      });
    }
  };

  return (
    <div id="vt-order-panel" style={{
      position: 'absolute',
      // 初期位置は左下（PalettePanelは右上で埋まっているため空いている場所）
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
          // 陽線・TPと同じティール（#26a69a）にして、チャート全体で「上＝ティール」の
          // 色の意味を統一する（以前はBUYだけ青で、色の対応をもう1つ覚える必要があった）
          style={sideBtn('#26a69a', selectedSide === 'BUY', !isLoaded || atEnd)}
        >BUY</button>
        <button
          onClick={() => setSelectedSide('SELL')}
          disabled={!isLoaded || atEnd}
          style={sideBtn('#c62828', selectedSide === 'SELL', !isLoaded || atEnd)}
        >SELL</button>
      </div>

      {/* 注文執行失敗時のエラー（残高不足・TP/SLの向きが矛盾等）。パネルを閉じずにここへ出す */}
      {error && (
        <div style={{
          color: '#ff7b72', backgroundColor: '#3a0d0d', border: '1px solid #ef5350',
          borderRadius: '4px', padding: '6px 10px', fontSize: '13px', fontWeight: 600,
        }}>{error}</div>
      )}

      {/* 注文執行（ここで確定。BUY/SELLで選んだ方向を実際に発注する） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={rowLabel} />
        <button
          onClick={handleExecute}
          disabled={!isLoaded || atEnd}
          style={orderBtn(selectedSide === 'BUY' ? '#00695c' : '#b71c1c', !isLoaded || atEnd)}
        >注文執行</button>
        {positions.length > 1 && (
          <button onClick={closeAll} style={orderBtn('#333', false)}>全決済</button>
        )}
      </div>
    </div>
  );
}
