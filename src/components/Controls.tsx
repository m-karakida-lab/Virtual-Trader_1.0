import { useEffect, useRef, useState } from 'react';
import { useTraderStore, selectUnrealizedPnL } from '../store/useTraderStore';
import { TIMEFRAMES, type Position, type PendingOrder, type OrderType } from '../types';
import { currencySymbol } from '../lib/currency';
import { inferPipSize, pricePrecision } from '../lib/pips';
import { captureChartArea } from '../lib/screenshot';
import { readErrorLog, clearErrorLog } from '../lib/errorLog';
import {
  isFileSystemAccessSupported as isErrorLogFileSupported,
  pickErrorLogFile, forgetErrorLogFile, getErrorLogFileName,
  readErrorLogFileText, clearErrorLogFile,
} from '../lib/errorLogFile';

// "YYYY-MM-DD" + "HH:mm" を UTC 前提で Unix秒に変換
function parseDateAsUTC(dateStr: string): number | null {
  const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const [, y, mo, d] = dm;
  return Math.floor(Date.UTC(+y, +mo - 1, +d, 0, 0) / 1000);
}

// Unix秒 → "YYYY-MM-DD"（UTC基準、datetime input の min/max 用）
function toDateUTC(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

// Unix秒 → "M/D HH:mm"（UTC基準、垂直線チップ表示用）。DrawToolbarの描画管理ポップアップからも使う
export function fmtVTime(sec: number): string {
  const d = new Date(sec * 1000);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${M}/${D} ${hh}:${mm}`;
}

const fmt  = (n: number) => Math.round(n).toLocaleString('ja-JP');
const fmtp = (n: number, sym: string) => (n >= 0 ? `+${sym}${fmt(n)}` : `-${sym}${fmt(Math.abs(n))}`);

const LOT_OPTIONS = [1_000, 3_000, 5_000, 10_000, 20_000, 50_000, 100_000];

const pnlColor = (n: number) => n > 0 ? '#26a69a' : n < 0 ? '#ef5350' : '#444';

const DEFAULT_TP_SL_PIPS = 50;

const miniBtn = (color: string): React.CSSProperties => ({
  background: 'none', border: `1px solid ${color}55`, color,
  borderRadius: '3px', padding: '1px 6px', cursor: 'pointer', fontSize: '12px',
});

// チャートクリックで値を取得するボタン（押すとピッキングモードに入る）
const pickBtn = (color: string, active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#141414' : active ? `${color}33` : '#1a1a1a',
  border: `1px solid ${disabled ? '#222' : active ? color : '#2a2a2a'}`,
  borderRadius: '3px', padding: '6px 8px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '14px',
});

// ── ポジション1行 ──────────────────────────────────────────────────────────
function PositionRow({
  pos, pnl, sym, onClose, onAddTP, onAddSL, onRemoveTP, onRemoveSL,
}: {
  pos: Position; pnl: number; sym: string; onClose: () => void;
  onAddTP: () => void; onAddSL: () => void; onRemoveTP: () => void; onRemoveSL: () => void;
}) {
  const prec = pricePrecision(pos.openPrice);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '5px 16px', borderTop: '1px solid #1a1a1a', fontSize: '16px',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{
        color: pos.side === 'BUY' ? '#26a69a' : '#ef5350',
        fontWeight: 700, minWidth: '32px',
      }}>{pos.side}</span>
      <span style={{ color: '#888' }}>{pos.lots.toLocaleString()}</span>
      <span style={{ color: '#555' }}>@ {pos.openPrice.toFixed(prec)}</span>
      {pos.tp !== undefined ? (
        <span style={{ color: '#26a69a', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '3px' }}>
          TP {pos.tp.toFixed(prec)}
          <button onClick={onRemoveTP} style={{ background: 'none', border: 'none', color: '#26a69a', cursor: 'pointer', fontSize: '13px' }}>×</button>
        </span>
      ) : (
        <button onClick={onAddTP} style={miniBtn('#26a69a')}>+TP</button>
      )}
      {pos.sl !== undefined ? (
        <span style={{ color: '#ef5350', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '3px' }}>
          SL {pos.sl.toFixed(prec)}
          <button onClick={onRemoveSL} style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: '13px' }}>×</button>
        </span>
      ) : (
        <button onClick={onAddSL} style={miniBtn('#ef5350')}>+SL</button>
      )}
      <span style={{ color: pnlColor(pnl), flex: 1, textAlign: 'right' }}>{fmtp(pnl, sym)}</span>
      <button onClick={onClose} style={{
        backgroundColor: '#2a1010', color: '#c62828', border: '1px solid #3a1818',
        borderRadius: '3px', padding: '3px 10px', cursor: 'pointer', fontSize: '15px',
      }}>決済</button>
    </div>
  );
}

// ── 未約定注文1行 ──────────────────────────────────────────────────────────
function OrderRow({ order, onCancel }: { order: PendingOrder; onCancel: () => void }) {
  const prec = pricePrecision(order.price);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '5px 16px', borderTop: '1px solid #1a1a1a', fontSize: '16px',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{
        color: order.side === 'BUY' ? '#42a5f5' : '#ab47bc',
        fontWeight: 700, minWidth: '88px',
      }}>{order.side} {order.type === 'limit' ? 'LIMIT' : 'STOP'}</span>
      <span style={{ color: '#888' }}>{order.lots.toLocaleString()}</span>
      <span style={{ color: '#555' }}>@ {order.price.toFixed(prec)}</span>
      {order.tp !== undefined && <span style={{ color: '#26a69a', fontSize: '13px' }}>TP {order.tp.toFixed(prec)}</span>}
      {order.sl !== undefined && <span style={{ color: '#ef5350', fontSize: '13px' }}>SL {order.sl.toFixed(prec)}</span>}
      <span style={{ flex: 1 }} />
      <button onClick={onCancel} style={{
        backgroundColor: '#2a1010', color: '#c62828', border: '1px solid #3a1818',
        borderRadius: '3px', padding: '3px 10px', cursor: 'pointer', fontSize: '15px',
      }}>取消</button>
    </div>
  );
}

// ── クリックで開閉するメニューボタン（下部バーの上方向にポップアップ）───────────
function MenuButton({
  label, active = false, disabled = false, children,
}: {
  label: string; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
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
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        style={tfBtn(active || open, disabled)}
      >{label} {open ? '▴' : '▾'}</button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
          backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
          padding: '12px', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)', zIndex: 60,
          minWidth: 'max-content', maxWidth: '90vw',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── エラーログの保存先設定（メニュー） ──────────────────────────────────────
// 問題が起きた時に後から調査できるよう、エラーログ（errorLog.ts）を実ファイルへも
// 追記できるようにする設定。File System Access API対応ブラウザ（Chrome/Edge）限定。
// 非対応ブラウザ・未設定時でも、localStorageのリングバッファをその場でダウンロードする
// フォールバックは常に使える
function ErrorLogMenu() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = isErrorLogFileSupported();

  useEffect(() => {
    if (!supported) return;
    getErrorLogFileName().then(setFileName);
  }, [supported]);

  const handlePick = async () => {
    setBusy(true);
    const handle = await pickErrorLogFile();
    setBusy(false);
    if (handle) setFileName(handle.name);
  };

  const handleForget = async () => {
    await forgetErrorLogFile();
    setFileName(null);
  };

  // ファイル保存先が選ばれていればその中身（全履歴）を、無ければlocalStorageの
  // リングバッファ（直近分のみ）をフォールバックとして、新規タブで開く
  // （ダウンロードだと毎回ファイルが増えて煩わしいという指摘を受けて変更）。
  // window.openはawaitの後だとユーザー操作の延長とみなされずポップアップブロックの
  // 対象になりうるため、先に空タブを同期的に開いてから中身を書き込む
  const handleOpen = async () => {
    const win = window.open('', '_blank');
    const fileText = await readErrorLogFileText();
    const text = fileText ?? readErrorLog()
      .map(e => `[${e.time}] [${e.source}] ${e.message}${e.stack ? '\n' + e.stack : ''}`)
      .join('\n\n');
    if (!win) return; // ポップアップブロック時は諦める（フォールバックのダウンロード導線は持たない）
    win.document.title = 'エラーログ';
    win.document.body.style.cssText = 'white-space:pre-wrap;font-family:monospace;font-size:12px;';
    win.document.body.textContent = text || '（記録なし）';
  };

  const handleClear = async () => {
    if (!window.confirm('エラーログを消去します。よろしいですか?')) return;
    clearErrorLog();
    await clearErrorLogFile();
  };

  return (
    <MenuButton label="🪲 ログ">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '280px' }}>
        {supported ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: '#888' }}>
              自動追記の保存先: {fileName ? <span style={{ color: '#e0e0e0' }}>{fileName}</span> : '未設定'}
            </span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handlePick} disabled={busy} style={tfBtn(false, busy)}>
                {fileName ? '保存先を変更...' : '保存先を選ぶ...'}
              </button>
              {fileName && (
                <button onClick={handleForget} style={tfBtn(false, false)}>解除</button>
              )}
            </div>
          </div>
        ) : (
          <span style={{ fontSize: '13px', color: '#888' }}>
            このブラウザはファイルへの自動追記に非対応です（Chrome/Edgeのみ）。下のダウンロードのみ使えます
          </span>
        )}
        <span style={{ height: '1px', backgroundColor: '#2a2a2a' }} />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={handleOpen} style={tfBtn(false, false)}>ログファイルを開く</button>
          <button onClick={handleClear} style={tfBtn(false, false)}>ログをクリア</button>
        </div>
      </div>
    </MenuButton>
  );
}

// ── メインコントロール ──────────────────────────────────────────────────────
export function Controls() {
  const advance       = useTraderStore(s => s.advance);
  const jumpToTime    = useTraderStore(s => s.jumpToTime);
  const fitToScreen   = useTraderStore(s => s.fitToScreen);
  const scrollToLatest = useTraderStore(s => s.scrollToLatest);
  const submitOrder   = useTraderStore(s => s.submitOrder);
  const closePosition = useTraderStore(s => s.closePosition);
  const closeAll      = useTraderStore(s => s.closeAll);
  const cancelOrder   = useTraderStore(s => s.cancelOrder);
  const setPositionTP = useTraderStore(s => s.setPositionTP);
  const setPositionSL = useTraderStore(s => s.setPositionSL);
  const setOrderType  = useTraderStore(s => s.setOrderType);
  const setDraftPrice = useTraderStore(s => s.setDraftPrice);
  const setDraftTP    = useTraderStore(s => s.setDraftTP);
  const setDraftSL    = useTraderStore(s => s.setDraftSL);
  const clearDraft    = useTraderStore(s => s.clearDraft);
  const togglePickTarget = useTraderStore(s => s.togglePickTarget);
  const pickTarget    = useTraderStore(s => s.pickTarget);
  const setLots       = useTraderStore(s => s.setLots);
  const setSpeed      = useTraderStore(s => s.setSpeed);
  const chartLayout   = useTraderStore(s => s.chartLayout);
  const symbol        = useTraderStore(s => s.symbol);
  const setChartLayout = useTraderStore(s => s.setChartLayout);
  const toggleEMA     = useTraderStore(s => s.toggleEMA);
  const toggleSMA     = useTraderStore(s => s.toggleSMA);
  const toggleBB      = useTraderStore(s => s.toggleBB);
  const toggleCloud   = useTraderStore(s => s.toggleCloud);
  const toggleWeekLines = useTraderStore(s => s.toggleWeekLines);
  const toggleSessions = useTraderStore(s => s.toggleSessions);
  const toggleHistoryPanel = useTraderStore(s => s.toggleHistoryPanel);
  const showHistoryPanel = useTraderStore(s => s.showHistoryPanel);
  const advanceToEnd = useTraderStore(s => s.advanceToEnd);
  const isDrawingLine = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring = useTraderStore(s => s.isMeasuring);
  const isDrawingRect = useTraderStore(s => s.isDrawingRect);
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingArrow = useTraderStore(s => s.isDrawingArrow);
  const isDrawingBrush = useTraderStore(s => s.isDrawingBrush);
  const isDrawingText = useTraderStore(s => s.isDrawingText);
  const showEMA       = useTraderStore(s => s.showEMA);
  const showSMA       = useTraderStore(s => s.showSMA);
  const showBB        = useTraderStore(s => s.showBB);
  const showCloud     = useTraderStore(s => s.showCloud);
  const showWeekLines = useTraderStore(s => s.showWeekLines);
  const showSessions = useTraderStore(s => s.showSessions);
  const balance       = useTraderStore(s => s.balance);
  const initialBalance = useTraderStore(s => s.initialBalance);
  const setInitialBalance = useTraderStore(s => s.setInitialBalance);
  const resetAccount  = useTraderStore(s => s.resetAccount);
  const quoteCurrency = useTraderStore(s => s.quoteCurrency);
  const positions     = useTraderStore(s => s.positions);
  const pendingOrders = useTraderStore(s => s.pendingOrders);
  const orderType     = useTraderStore(s => s.orderType);
  const draftPrice    = useTraderStore(s => s.draftPrice);
  const draftTP       = useTraderStore(s => s.draftTP);
  const draftSL       = useTraderStore(s => s.draftSL);
  const lots          = useTraderStore(s => s.lots);
  const lotMode       = useTraderStore(s => s.lotMode);
  const setLotMode    = useTraderStore(s => s.setLotMode);
  const riskPercent   = useTraderStore(s => s.riskPercent);
  const setRiskPercent = useTraderStore(s => s.setRiskPercent);
  const candles       = useTraderStore(s => s.candles);
  const timeframeSec  = useTraderStore(s => s.timeframeSec);
  const cursor        = useTraderStore(s => s.cursor);
  const isLoaded      = useTraderStore(s => s.isLoaded);
  const isPlaying     = useTraderStore(s => s.isPlaying);
  const speed         = useTraderStore(s => s.speed);
  const totalPnl      = useTraderStore(selectUnrealizedPnL);

  const timeframeLabel = TIMEFRAMES.find(t => t.sec === timeframeSec)?.label ?? '';
  // 最後の足まで進んでいる（=もう先に反応できる未来が無い）間は発注・速度変更を無効化する
  const atEnd = candles.length > 0 && cursor >= candles.length - 1;
  const sym = currencySymbol(quoteCurrency);
  const priceStep = candles.length > 0 ? 1 / 10 ** pricePrecision(candles[0].close) : 0.00001;

  // ポジション別含み損益
  const current = candles[cursor];

  // リスク%モードのロット数プレビュー（成行=現在値、指値/逆指値=draftPrice をエントリー価格として使う）
  const entryPriceForRisk = orderType === 'market' ? current?.close ?? null : draftPrice;
  const riskLotsPreview = (lotMode === 'risk' && draftSL !== null && entryPriceForRisk !== null && entryPriceForRisk !== draftSL)
    ? Math.round((balance * (riskPercent / 100)) / Math.abs(entryPriceForRisk - draftSL))
    : null;
  const posPnlMap = new Map(positions.map(pos => {
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnl = current ? (current.close - pos.openPrice) * pos.lots * dir : 0;
    return [pos.id, pnl];
  }));

  const timeStr = current ? (() => {
    const d = new Date(current.time * 1000);
    const M = d.getUTCMonth() + 1;
    const D = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${M}/${D} ${hh}:${mm}`;
  })() : '—';

  // 発注パネルの開閉。他のMenuButton群と違い「画面外クリックで閉じる」を採用しない——
  // TP/SL/価格の📍ボタンでチャート上をクリックして値を拾う操作自体が「パネルの外側クリック」に
  // 該当してしまい、値を拾おうとするたびにパネルが閉じてしまうため。発注ボタンの再クリックか
  // BUY/SELL確定でのみ閉じる（下のuseEffectとsubmitOrder呼び出し側を参照）
  const [orderPanelOpen, setOrderPanelOpen] = useState(false);

  const [jumpDate, setJumpDate] = useState('');
  const handleJump = () => {
    const sec = parseDateAsUTC(jumpDate);
    if (sec !== null) jumpToTime(sec);
  };
  // 「移動」は表示位置だけ動かす（最新足＝リプレイの開示境界はそのまま）。
  // 「巻き戻し」は指定日付を新しい最新足にする（それより先の足を隠す）
  const handleRewind = () => {
    const sec = parseDateAsUTC(jumpDate);
    if (sec !== null) jumpToTime(sec, { rewind: true });
  };
  const minDate = candles.length > 0 ? toDateUTC(candles[0].time) : undefined;
  const maxDate = candles.length > 0 ? toDateUTC(candles[candles.length - 1].time) : undefined;

  // rAF 自動再生
  useEffect(() => {
    if (!isPlaying) return;
    const msPerCandle = Math.round(500 / speed);
    let lastTick = performance.now();
    let rafId: number;
    const loop = (now: number) => {
      if (now - lastTick >= msPerCandle) {
        lastTick = now;
        if (!advance()) return;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, speed, advance]);

  const orderPanel = (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', maxWidth: '640px',
      }}>
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
              style={{
                backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
                borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width: '60px',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
            <span style={{ color: '#555', fontSize: '14px' }}>%</span>
            <span style={{ color: '#666', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
              {riskLotsPreview !== null ? `→ ${riskLotsPreview.toLocaleString()}通貨` : '→ SLを設定'}
            </span>
          </div>
        )}

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

        {orderType !== 'market' && (
          <div style={{ display: 'flex', gap: '3px' }}>
            <input
              type="number"
              placeholder="価格"
              value={draftPrice ?? ''}
              onChange={e => setDraftPrice(e.target.value === '' ? null : Number(e.target.value))}
              step={priceStep}
              style={{
                backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
                borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width: '100px',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
            <button
              onClick={() => togglePickTarget('price')}
              disabled={!isLoaded}
              style={pickBtn('#888', pickTarget === 'price', !isLoaded)}
            >📍</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '3px' }}>
          <input
            type="number"
            placeholder="TP"
            value={draftTP ?? ''}
            onChange={e => setDraftTP(e.target.value === '' ? null : Number(e.target.value))}
            step={priceStep}
            style={{
              backgroundColor: '#1a1a1a', color: '#26a69a', border: '1px solid #1a3a35',
              borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width: '90px',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <button
            onClick={() => togglePickTarget('tp')}
            disabled={!isLoaded}
            style={pickBtn('#26a69a', pickTarget === 'tp', !isLoaded)}
          >📍</button>
        </div>
        <div style={{ display: 'flex', gap: '3px' }}>
          <input
            type="number"
            placeholder="SL"
            value={draftSL ?? ''}
            onChange={e => setDraftSL(e.target.value === '' ? null : Number(e.target.value))}
            step={priceStep}
            style={{
              backgroundColor: '#1a1a1a', color: '#ef5350', border: '1px solid #3a1a1a',
              borderRadius: '3px', padding: '6px 8px', fontSize: '15px', width: '90px',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <button
            onClick={() => togglePickTarget('sl')}
            disabled={!isLoaded}
            style={pickBtn('#ef5350', pickTarget === 'sl', !isLoaded)}
          >📍</button>
        </div>
        {(draftPrice !== null || draftTP !== null || draftSL !== null || pickTarget !== null) && (
          <button
            onClick={clearDraft}
            title="価格・TP・SLの下書きをクリア"
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '6px 10px', fontSize: '15px', cursor: 'pointer',
            }}
          >クリア</button>
        )}
        <button onClick={() => { submitOrder('BUY');  setOrderPanelOpen(false); }}  disabled={!isLoaded || atEnd} style={orderBtn('#0d47a1', !isLoaded || atEnd)}>BUY</button>
        <button onClick={() => { submitOrder('SELL'); setOrderPanelOpen(false); }} disabled={!isLoaded || atEnd} style={orderBtn('#b71c1c', !isLoaded || atEnd)}>SELL</button>
        {positions.length > 1 && (
          <button onClick={closeAll} style={orderBtn('#333', false)}>全決済</button>
        )}
      </div>
  );

  return (
    <div style={{ borderTop: '1px solid #1e1e1e', backgroundColor: '#0d0d0d' }}>

      {/* ── 未約定注文一覧 ──────────────────────────────────────── */}
      {pendingOrders.length > 0 && (
        <div style={{ maxHeight: '80px', overflowY: 'auto', borderBottom: '1px solid #1a1a1a' }}>
          {pendingOrders.map(order => (
            <OrderRow key={order.id} order={order} onCancel={() => cancelOrder(order.id)} />
          ))}
        </div>
      )}

      {/* ── ポジション一覧（常にメイン行の上）─ スクロール可 ────── */}
      {positions.length > 0 && (
        <div style={{ maxHeight: '80px', overflowY: 'auto', borderBottom: '1px solid #1a1a1a' }}>
          {positions.map(pos => {
            const pip = inferPipSize(pos.openPrice);
            const dir = pos.side === 'BUY' ? 1 : -1;
            return (
              <PositionRow
                key={pos.id}
                pos={pos}
                pnl={posPnlMap.get(pos.id) ?? 0}
                sym={sym}
                onClose={() => closePosition(pos.id)}
                onAddTP={() => setPositionTP(pos.id, pos.openPrice + dir * DEFAULT_TP_SL_PIPS * pip)}
                onAddSL={() => setPositionSL(pos.id, pos.openPrice - dir * DEFAULT_TP_SL_PIPS * pip)}
                onRemoveTP={() => setPositionTP(pos.id, undefined)}
                onRemoveSL={() => setPositionSL(pos.id, undefined)}
              />
            );
          })}
        </div>
      )}

      {/* ── メイン行（常に最下部・固定）───────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0', height: '72px' }}>

        {/* 口座情報 */}
        <div style={{ flex: 1, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: '4px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ color: '#555', fontSize: '16px' }}>残高</span>
            <span style={{ color: '#e0e0e0', fontSize: '20px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {sym}{fmt(balance)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <span style={{ color: pnlColor(totalPnl), fontSize: '17px', fontVariantNumeric: 'tabular-nums' }}>
              {positions.length === 0 ? <span style={{ color: '#333' }}>含み損益: —</span> : `含み ${fmtp(totalPnl, sym)}`}
            </span>
            <span style={{ color: '#2a2a2a', fontSize: '16px' }}>{timeStr} · {timeframeLabel}</span>
          </div>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 初期残高設定 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px', flexShrink: 0 }}>
          <span style={{ color: '#555', fontSize: '13px' }}>初期残高</span>
          <input
            type="number"
            value={initialBalance}
            onChange={e => setInitialBalance(Number(e.target.value))}
            min={0}
            step={10000}
            style={{
              backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
              borderRadius: '3px', padding: '6px 8px', fontSize: '14px', width: '110px',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <button
            onClick={resetAccount}
            disabled={!isLoaded}
            style={tfBtn(false, !isLoaded)}
          >リセット</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* チャートレイアウト */}
        <div style={{ display: 'flex', gap: '3px', padding: '0 8px', flexShrink: 0 }}>
          <button
            onClick={() => setChartLayout('1')}
            disabled={!isLoaded}
            style={tfBtn(chartLayout === '1', !isLoaded)}
          >1画面</button>
          <button
            onClick={() => setChartLayout('4')}
            disabled={!isLoaded}
            style={tfBtn(chartLayout === '4', !isLoaded)}
          >4画面</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 表示モード */}
        <div style={{ display: 'flex', gap: '3px', padding: '0 8px', flexShrink: 0 }}>
          <button
            onClick={advanceToEnd}
            disabled={!isLoaded || atEnd}
            style={tfBtn(false, !isLoaded)}
          >チャート全表示</button>
          <button
            onClick={fitToScreen}
            disabled={!isLoaded}
            style={tfBtn(false, !isLoaded)}
          >表示をリセット</button>
          <button
            onClick={scrollToLatest}
            disabled={!isLoaded}
            style={tfBtn(false, !isLoaded)}
          >最新足に固定</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 発注パネル。他のメニューと違い画面外クリックでは閉じない（📍でチャートを
            クリックする操作を妨げないため。orderPanelOpenのコメント参照） */}
        <div style={{ position: 'relative', padding: '0 8px', flexShrink: 0 }}>
          <button
            onClick={() => setOrderPanelOpen(o => !o)}
            disabled={!isLoaded}
            style={tfBtn(pickTarget !== null || orderPanelOpen, !isLoaded)}
          >発注 {orderPanelOpen ? '▴' : '▾'}</button>
          {orderPanelOpen && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
              backgroundColor: '#141414', border: '1px solid #2a2a2a', borderRadius: '6px',
              padding: '12px', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)', zIndex: 60,
              minWidth: 'max-content', maxWidth: '90vw',
            }}>
              {orderPanel}
            </div>
          )}
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* インジケータ（メニュー）。描画物の一覧/削除はDrawToolbar（画面左のパネル）側が担う */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <MenuButton
            label="インジケータ"
            disabled={!isLoaded}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', minWidth: '340px' }}>
              <button onClick={toggleEMA} disabled={!isLoaded} style={tfBtn(showEMA, !isLoaded)}>EMA200</button>
              <button onClick={toggleSMA} disabled={!isLoaded} style={tfBtn(showSMA, !isLoaded)}>SMA14</button>
              <button onClick={toggleBB} disabled={!isLoaded} style={tfBtn(showBB, !isLoaded)}>BB(20, ±1σ/±2σ)</button>
              <button onClick={toggleCloud} disabled={!isLoaded} style={tfBtn(showCloud, !isLoaded)}>雲</button>
              <button onClick={toggleWeekLines} disabled={!isLoaded} style={tfBtn(showWeekLines, !isLoaded)}>区間区切り</button>
              <button onClick={toggleSessions} disabled={!isLoaded} style={tfBtn(showSessions, !isLoaded)}>セッション</button>
              {(isDrawingLine || isDrawingVLine || isMeasuring || isDrawingRect || isDrawingTrendLine || isDrawingArrow || isDrawingBrush || isDrawingText) && (
                <span style={{ color: '#42a5f5', fontSize: '14px' }}>
                  {isDrawingLine && 'クリックで配置...'}
                  {isDrawingVLine && 'クリックで配置...'}
                  {isMeasuring && 'ドラッグで計測...'}
                  {isDrawingRect && 'ドラッグで描画...'}
                  {isDrawingTrendLine && 'ドラッグで描画...'}
                  {isDrawingArrow && 'ドラッグで描画...'}
                  {isDrawingBrush && 'ドラッグで描画...'}
                  {isDrawingText && 'クリックで配置...'}
                  （左のアイコンで再度クリックすると解除）
                </span>
              )}
            </div>
          </MenuButton>
        </div>

        <button onClick={toggleHistoryPanel} disabled={!isLoaded} style={tfBtn(showHistoryPanel, !isLoaded)}>履歴</button>

        <button
          onClick={() => captureChartArea(`${symbol || 'chart'}_${chartLayout === '4' ? '4画面' : timeframeLabel}`)}
          disabled={!isLoaded}
          title="チャート画面（価格軸・日付軸含む）をJPEGで保存"
          style={tfBtn(false, !isLoaded)}
        >📷 キャプチャ</button>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0, margin: '0 8px' }} />

        {/* 日付ジャンプ（メニュー） */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <MenuButton label="📅 日付移動" disabled={!isLoaded}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="date"
                value={jumpDate}
                onChange={e => setJumpDate(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && isLoaded && jumpDate) handleJump(); }}
                min={minDate}
                max={maxDate}
                disabled={!isLoaded}
                style={{
                  backgroundColor: '#1a1a1a', color: '#888', border: '1px solid #2a2a2a',
                  borderRadius: '3px', padding: '8px 8px', fontSize: '20px',
                  colorScheme: 'dark',
                }}
              />
              <button
                onClick={handleJump}
                disabled={!isLoaded || !jumpDate}
                style={tfBtn(false, !isLoaded || !jumpDate)}
              >移動</button>
              <button
                onClick={handleRewind}
                disabled={!isLoaded || !jumpDate}
                title="指定日付を最新足にする（それより先の足を隠す）"
                style={tfBtn(false, !isLoaded || !jumpDate)}
              >巻き戻し</button>
            </div>
          </MenuButton>
        </div>

        {/* エラーログの保存先（メニュー）。isLoadedに関わらず常に使える設定なのでdisabled指定なし */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <ErrorLogMenu />
        </div>

        {/* 速度（再生・1コマ送り/戻りはチャート上のフロートボタンへ） */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px', gap: '4px', flexShrink: 0 }}>
          <span style={{ color: '#555', fontSize: '14px' }}>
            速度 <span style={{ color: '#777', fontVariantNumeric: 'tabular-nums' }}>{speed}x</span>
          </span>
          <input
            type="range" min={1} max={20} step={1} value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
            disabled={atEnd}
            style={{ width: '72px', accentColor: '#444' }}
          />
        </div>

      </div>

    </div>
  );
}

const tfBtn = (active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#141414' : active ? '#2a2a2a' : '#161616',
  color: disabled ? '#333' : active ? '#e0e0e0' : '#666',
  border: active ? '1px solid #3a3a3a' : '1px solid #222',
  borderRadius: '3px',
  padding: '6px 10px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '15px',
  fontWeight: 700,
});

const orderBtn = (bg: string, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#1a1a1a' : bg,
  color: disabled ? '#333' : '#fff',
  border: 'none', borderRadius: '3px',
  padding: '8px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '17px', fontWeight: 700, letterSpacing: '0.05em',
});

