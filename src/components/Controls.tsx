import { useEffect, useRef, useState } from 'react';
import { useTraderStore } from '../store/useTraderStore';
import { type Position, type PendingOrder } from '../types';
import { currencySymbol } from '../lib/currency';
import { inferPipSize, pricePrecision } from '../lib/pips';
import { readErrorLog, clearErrorLog } from '../lib/errorLog';
import { fmtSavedAt } from './FileLoader';
import {
  isFileSystemAccessSupported as isErrorLogFileSupported,
  pickErrorLogFile, forgetErrorLogFile, getErrorLogFileName,
  readErrorLogFileText, clearErrorLogFile,
} from '../lib/errorLogFile';

// 全角数字（U+FF10-FF19）を半角に矯正する。日付移動の年/月/日欄はIME入力で全角になりがちなため
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 年/月/日を別々の入力欄から受け取ってUnix秒へ変換。年は空欄可で、その場合は
// currentYearSec（現在リプレイ中の足の時刻）が指す年を補う
function buildJumpSec(yearStr: string, monthStr: string, dayStr: string, currentYearSec?: number): number | null {
  const moStr = monthStr.trim(), dStr = dayStr.trim();
  if (!/^\d{1,2}$/.test(moStr) || !/^\d{1,2}$/.test(dStr)) return null;
  const mo = +moStr, d = +dStr;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const yStr = yearStr.trim();
  if (yStr && !/^\d{4}$/.test(yStr)) return null;
  const y = yStr ? +yStr : new Date((currentYearSec ?? 0) * 1000).getUTCFullYear();
  const sec = Math.floor(Date.UTC(y, mo - 1, d, 0, 0) / 1000);
  // Date.UTCは月/日が範囲外でも繰り上げてしまう（例: 2/30→3/2）。往復させて弾く
  const check = new Date(sec * 1000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return sec;
}

// 日付移動の年/月/日入力欄（幅だけ違う）
function jumpFieldStyle(width: string): React.CSSProperties {
  return {
    backgroundColor: '#1a1a1a', color: '#e0e0e0', border: '1px solid #2a2a2a',
    borderRadius: '3px', padding: '8px 6px', fontSize: '14px', width, textAlign: 'center',
  };
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

const pnlColor = (n: number) => n > 0 ? '#26a69a' : n < 0 ? '#ef5350' : '#444';

const DEFAULT_TP_SL_PIPS = 50;

const miniBtn = (color: string): React.CSSProperties => ({
  background: 'none', border: `1px solid ${color}55`, color,
  borderRadius: '3px', padding: '1px 6px', cursor: 'pointer', fontSize: '12px',
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
// open/onOpenChangeを渡すと開閉を外側から制御できる（例: 日付移動は「移動」実行後に自動で閉じたい）。
// 渡さなければ従来通り内部stateだけで開閉する
function MenuButton({
  label, active = false, disabled = false, children, open: openProp, onOpenChange,
}: {
  label: string; active?: boolean; disabled?: boolean; children: React.ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => { onOpenChange ? onOpenChange(next) : setInternalOpen(next); };
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
        onClick={() => setOpen(!open)}
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

// ── 設定メニュー内の1項目（見出し + 内容）。区切り線・余白を統一する ──────────
function SettingsSection({
  icon, title, children, last = false,
}: {
  icon: string; title: string; children: React.ReactNode; last?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '10px 0', borderBottom: last ? 'none' : '1px solid #2a2a2a',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#42a5f5', fontSize: '15px', fontWeight: 700 }}>
        <span>{icon}</span>{title}
      </span>
      {children}
    </div>
  );
}

// ── エラーログの保存先設定（メニュー） ──────────────────────────────────────
// 問題が起きた時に後から調査できるよう、エラーログ（errorLog.ts）を実ファイルへも
// 追記できるようにする設定。File System Access API対応ブラウザ（Chrome/Edge）限定。
// 非対応ブラウザ・未設定時でも、localStorageのリングバッファをその場でダウンロードする
// フォールバックは常に使える
function ErrorLogSection() {
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
      <div style={{ display: 'flex', gap: '6px' }}>
        <button onClick={handleOpen} style={tfBtn(false, false)}>ログファイルを開く</button>
        <button onClick={handleClear} style={tfBtn(false, false)}>ログをクリア</button>
      </div>
    </div>
  );
}

// ── メインコントロール ──────────────────────────────────────────────────────
export function Controls() {
  const advance       = useTraderStore(s => s.advance);
  const jumpToTime    = useTraderStore(s => s.jumpToTime);
  const fitToScreen   = useTraderStore(s => s.fitToScreen);
  const scrollToLatest = useTraderStore(s => s.scrollToLatest);
  const closePosition = useTraderStore(s => s.closePosition);
  const cancelOrder   = useTraderStore(s => s.cancelOrder);
  const setPositionTP = useTraderStore(s => s.setPositionTP);
  const setPositionSL = useTraderStore(s => s.setPositionSL);
  const setSpeed      = useTraderStore(s => s.setSpeed);
  const chartLayout   = useTraderStore(s => s.chartLayout);
  const setChartLayout = useTraderStore(s => s.setChartLayout);
  const quad3Pattern = useTraderStore(s => s.quad3Pattern);
  const toggleQuad3Pattern = useTraderStore(s => s.toggleQuad3Pattern);
  const autoSaveArmed = useTraderStore(s => s.autoSaveArmed);
  const lastSavedAt = useTraderStore(s => s.lastSavedAt);
  const toggleEMA     = useTraderStore(s => s.toggleEMA);
  const toggleSMA     = useTraderStore(s => s.toggleSMA);
  const toggleBB      = useTraderStore(s => s.toggleBB);
  const toggleCloud   = useTraderStore(s => s.toggleCloud);
  const toggleWeekLines = useTraderStore(s => s.toggleWeekLines);
  const toggleSessions = useTraderStore(s => s.toggleSessions);
  const toggleHistoryPanel = useTraderStore(s => s.toggleHistoryPanel);
  const showHistoryPanel = useTraderStore(s => s.showHistoryPanel);
  const orderPanelOpen = useTraderStore(s => s.orderPanelOpen);
  const setOrderPanelOpen = useTraderStore(s => s.setOrderPanelOpen);
  const clearDraft = useTraderStore(s => s.clearDraft);
  const isDrawingLine = useTraderStore(s => s.isDrawingLine);
  const isDrawingVLine = useTraderStore(s => s.isDrawingVLine);
  const isMeasuring = useTraderStore(s => s.isMeasuring);
  const isDrawingRect = useTraderStore(s => s.isDrawingRect);
  const isDrawingTrendLine = useTraderStore(s => s.isDrawingTrendLine);
  const isDrawingChannel = useTraderStore(s => s.isDrawingChannel);
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
  const candles       = useTraderStore(s => s.candles);
  const cursor        = useTraderStore(s => s.cursor);
  const isLoaded      = useTraderStore(s => s.isLoaded);
  const isPlaying     = useTraderStore(s => s.isPlaying);
  const speed         = useTraderStore(s => s.speed);
  const stepBack      = useTraderStore(s => s.stepBack);
  const togglePlay    = useTraderStore(s => s.togglePlay);
  // 最後の足まで進んでいる（=もう先に反応できる未来が無い）間は発注・速度変更を無効化する
  const atEnd = candles.length > 0 && cursor >= candles.length - 1;
  const atStart = cursor <= 0;
  const sym = currencySymbol(quoteCurrency);

  // ポジション別含み損益
  const current = candles[cursor];
  const posPnlMap = new Map(positions.map(pos => {
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnl = current ? (current.close - pos.openPrice) * pos.lots * dir : 0;
    return [pos.id, pnl];
  }));

  const [jumpYear, setJumpYear] = useState('');
  const [jumpMonth, setJumpMonth] = useState('');
  const [jumpDay, setJumpDay] = useState('');
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  // 「現在いる年」= リプレイ上でいま開示されている足の時刻の年（現実の今日の年ではない）
  const currentYearSec = candles[cursor]?.time;
  const jumpSec = buildJumpSec(jumpYear, jumpMonth, jumpDay, currentYearSec);
  const resetJumpFields = () => { setJumpYear(''); setJumpMonth(''); setJumpDay(''); };
  const handleJump = () => {
    if (jumpSec === null) return;
    jumpToTime(jumpSec);
    resetJumpFields();
    setDateMenuOpen(false);
  };
  // 「移動」は表示位置だけ動かす（最新足＝リプレイの開示境界はそのまま）。
  // 「巻き戻し」は指定日付を新しい最新足にする（それより先の足を隠す）
  const handleRewind = () => {
    if (jumpSec === null) return;
    jumpToTime(jumpSec, { rewind: true });
    resetJumpFields();
    setDateMenuOpen(false);
  };

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0', padding: '6px 0' }}>

        {/* 左の描画ツールバー列（App.tsx、幅48px＋区切り線1px）とチャート下部のこの行は別要素
            なので、そのままだと残高がツールバーの真下に来て窮屈に見える。同じ幅の空きを
            入れて視覚的に列を揃える */}
        <div style={{ width: '49px', flexShrink: 0 }} />

        {/* 口座情報（残高のみ。含み損益・時刻はPositionRow一覧や別箇所で確認できるためここでは出さない）。
            クリックで取引履歴パネルへも飛べるようにする（「履歴」ボタンと同じトグル動作） */}
        <div
          onClick={() => isLoaded && toggleHistoryPanel()}
          title="クリックで取引履歴を表示"
          style={{
            flex: 1, padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '4px',
            overflow: 'hidden', cursor: isLoaded ? 'pointer' : 'default',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', lineHeight: 1.2 }}>
            <span style={{ color: '#555', fontSize: '16px' }}>残高</span>
            <span style={{ color: '#e0e0e0', fontSize: '20px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {sym}{fmt(balance)}
            </span>
          </div>
        </div>

        {/* 発注ボタン。パネル本体はパレット(PalettePanel)と同じ、チャート上に独立して浮かぶ
            ドラッグ可能なパネル（OrderPanel.tsx）を開閉するだけのトグル。以前はこの場所に
            ドロップダウンとして直接出していたが、項目が多くゴチャゴチャして見づらいという
            指摘を受けて独立パネル化した */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <button
            onClick={() => {
              // 発注ボタンの再クリックでパネルを閉じる時は、価格/TP/SLの仮入力（前回比率の
              // 再現分含む）もクリアする（クリアボタンと同じ動作）。開く時はそのまま
              // （パネルを開いた瞬間に前回比率の仮入力が別途走る）
              if (orderPanelOpen) clearDraft();
              setOrderPanelOpen(!orderPanelOpen);
            }}
            disabled={!isLoaded}
            style={tfBtn(orderPanelOpen, !isLoaded)}
          >発注</button>
        </div>

        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <button onClick={toggleHistoryPanel} disabled={!isLoaded} style={tfBtn(showHistoryPanel, !isLoaded)}>履歴</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* チャートレイアウト。1画面への切替はここでは行わず、各パネルヘッダー左上の
            全画面ボタン（ChartHeader）でそのパネルを1画面化する導線に一本化している */}
        <div style={{ display: 'flex', gap: '3px', padding: '0 8px', flexShrink: 0 }}>
          {/* 3画面中にもう一度押すと配置（左1枠+右2枠／上1枠+下2枠）が切り替わる */}
          <button
            onClick={() => { if (chartLayout === '3') toggleQuad3Pattern(); else setChartLayout('3'); }}
            disabled={!isLoaded}
            title={chartLayout === '3'
              ? (quad3Pattern === 'left' ? '3画面の配置を「上1枠+下2枠」に切替' : '3画面の配置を「左1枠+右2枠」に切替')
              : '3画面表示'}
            style={tfBtn(chartLayout === '3', !isLoaded)}
          >3画面</button>
          <button
            onClick={() => setChartLayout('4')}
            disabled={!isLoaded}
            style={tfBtn(chartLayout === '4', !isLoaded)}
          >4画面</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 表示モード。チャート全表示・キャプチャは上部のファイル選択と同じ行に移動済み */}
        <div style={{ display: 'flex', gap: '3px', padding: '0 8px', flexShrink: 0 }}>
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

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0, margin: '0 8px' }} />

        {/* 日付ジャンプ（メニュー） */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <MenuButton label="📅 日付移動" disabled={!isLoaded} open={dateMenuOpen} onOpenChange={setDateMenuOpen}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="text"
                inputMode="numeric"
                value={jumpYear}
                onChange={e => setJumpYear(toHalfWidthDigits(e.target.value))}
                onKeyDown={e => { if (e.key === 'Enter' && isLoaded && jumpSec !== null) handleJump(); }}
                placeholder="YYYY"
                title="空欄にすると現在いる年（リプレイ中の足の年）が使われます"
                disabled={!isLoaded}
                style={jumpFieldStyle('44px')}
              />
              <span style={{ color: '#555' }}>-</span>
              <input
                type="text"
                inputMode="numeric"
                value={jumpMonth}
                onChange={e => setJumpMonth(toHalfWidthDigits(e.target.value))}
                onKeyDown={e => { if (e.key === 'Enter' && isLoaded && jumpSec !== null) handleJump(); }}
                placeholder="MM"
                disabled={!isLoaded}
                style={jumpFieldStyle('32px')}
              />
              <span style={{ color: '#555' }}>-</span>
              <input
                type="text"
                inputMode="numeric"
                value={jumpDay}
                onChange={e => setJumpDay(toHalfWidthDigits(e.target.value))}
                onKeyDown={e => { if (e.key === 'Enter' && isLoaded && jumpSec !== null) handleJump(); }}
                placeholder="DD"
                disabled={!isLoaded}
                style={jumpFieldStyle('32px')}
              />
              <button
                onClick={handleJump}
                disabled={!isLoaded || jumpSec === null}
                style={tfBtn(false, !isLoaded || jumpSec === null)}
              >移動</button>
              <button
                onClick={handleRewind}
                disabled={!isLoaded || jumpSec === null}
                title="指定日付を最新足にする（それより先の足を隠す）"
                style={tfBtn(false, !isLoaded || jumpSec === null)}
              >巻き戻し</button>
            </div>
          </MenuButton>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 再生・1コマ戻る・1コマ進む。以前はチャート上に浮かぶ丸ボタン（FloatingControls）
            だったが、他の操作ボタンと統一感が無く場所も覚えにくいという指摘を受けてここへ
            移設した。左から再生・戻る・進むの順。よく使うボタンなので他のtfBtnより
            一回り大きく、アクセントカラーで目立たせる（playBtn） */}
        <div style={{ display: 'flex', gap: '4px', padding: '0 8px', flexShrink: 0 }}>
          <button
            onClick={togglePlay}
            disabled={!isLoaded || atEnd}
            title={isPlaying ? '一時停止' : '再生'}
            style={playBtn(isPlaying, !isLoaded || atEnd)}
          >{isPlaying ? '⏸' : '▶'}</button>
          <button
            onClick={() => stepBack()}
            disabled={!isLoaded || atStart}
            title="1コマ戻る"
            style={playBtn(false, !isLoaded || atStart)}
          >⏮</button>
          <button
            onClick={() => advance()}
            disabled={!isLoaded || atEnd || isPlaying}
            title="1コマ進む"
            style={playBtn(false, !isLoaded || atEnd || isPlaying)}
          >⏭</button>
        </div>

        <span style={{ width: '1px', height: '32px', backgroundColor: '#1e1e1e', flexShrink: 0 }} />

        {/* 設定（メニュー）。頻繁には使わない初期残高設定・インジケータ表示切替・ログ・
            再生速度をここにまとめる。他の操作系ボタンと混ざらないよう最右端に固定する */}
        <div style={{ padding: '0 8px', flexShrink: 0 }}>
          <MenuButton label="⚙ 設定">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '380px' }}>
              <SettingsSection icon="⏱" title="速度">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="range" min={1} max={20} step={1} value={speed}
                    onChange={e => setSpeed(Number(e.target.value))}
                    disabled={atEnd}
                    style={{ width: '120px', accentColor: '#444' }}
                  />
                  <span style={{ color: '#888', fontSize: '14px', fontVariantNumeric: 'tabular-nums' }}>{speed}x</span>
                </div>
              </SettingsSection>

              <SettingsSection icon="💰" title="初期残高">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
              </SettingsSection>

              <SettingsSection icon="📊" title="インジケータ">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={toggleEMA} disabled={!isLoaded} style={tfBtn(showEMA, !isLoaded)}>EMA200</button>
                  <button onClick={toggleSMA} disabled={!isLoaded} style={tfBtn(showSMA, !isLoaded)}>SMA14</button>
                  <button onClick={toggleBB} disabled={!isLoaded} style={tfBtn(showBB, !isLoaded)}>BB(20, ±1σ/±2σ)</button>
                  <button onClick={toggleCloud} disabled={!isLoaded} style={tfBtn(showCloud, !isLoaded)}>雲</button>
                  <button onClick={toggleWeekLines} disabled={!isLoaded} style={tfBtn(showWeekLines, !isLoaded)}>区間区切り</button>
                  <button onClick={toggleSessions} disabled={!isLoaded} style={tfBtn(showSessions, !isLoaded)}>セッション</button>
                </div>
                {(isDrawingLine || isDrawingVLine || isMeasuring || isDrawingRect || isDrawingTrendLine || isDrawingChannel || isDrawingArrow || isDrawingBrush || isDrawingText) && (
                  <span style={{ color: '#42a5f5', fontSize: '13px' }}>
                    {isDrawingLine && 'クリックで配置...'}
                    {isDrawingVLine && 'クリックで配置...'}
                    {isMeasuring && 'ドラッグで計測...'}
                    {isDrawingRect && 'ドラッグで描画...'}
                    {isDrawingTrendLine && 'ドラッグで描画...'}
                    {isDrawingChannel && 'ドラッグで基準線を描画→もう1クリックで幅を決定...'}
                    {isDrawingArrow && 'ドラッグで描画...'}
                    {isDrawingBrush && 'ドラッグで描画...'}
                    {isDrawingText && 'クリックで配置...'}
                    （左のアイコンで再度クリックすると解除）
                  </span>
                )}
              </SettingsSection>

              <SettingsSection icon="🪲" title="ログ">
                <ErrorLogSection />
              </SettingsSection>

              {/* 設定項目ではなく状態表示だけのセクション。常時表示し、OFF（一度も
                  上書き保存していない）の状態も分かるようにする */}
              <SettingsSection icon="💾" title="自動保存" last>
                <span style={{ color: autoSaveArmed ? '#888' : '#555', fontSize: '13px' }}>
                  {autoSaveArmed
                    ? <>ON{lastSavedAt !== null ? `・最終保存 ${fmtSavedAt(lastSavedAt)}` : ''}</>
                    : 'OFF（「上書き保存」を1回行うと有効になります）'}
                  {autoSaveArmed && <span style={{ color: '#555' }}>（10分ごと、変更があった時のみ）</span>}
                </span>
              </SettingsSection>
            </div>
          </MenuButton>
        </div>

      </div>

    </div>
  );
}

export const tfBtn = (active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#141414' : active ? '#2a2a2a' : '#161616',
  color: disabled ? '#333' : active ? '#e0e0e0' : '#666',
  border: active ? '1px solid #3a3a3a' : '1px solid #222',
  borderRadius: '3px',
  padding: '3px 10px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '15px',
  fontWeight: 700,
});

// 再生・1コマ戻る・1コマ進む専用。頻繁に使うボタンなので他のtfBtnより一回り大きく、
// アクセントカラー（BUYボタン等と同じ#1565c0系の青）で目立たせる
const playBtn = (active: boolean, disabled: boolean): React.CSSProperties => ({
  backgroundColor: disabled ? '#141414' : active ? '#1565c0' : '#0f2038',
  color: disabled ? '#333' : '#fff',
  border: disabled ? '1px solid #222' : '1px solid #1976d2',
  borderRadius: '3px',
  padding: '5px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '19px',
  fontWeight: 700,
  lineHeight: 1,
});

