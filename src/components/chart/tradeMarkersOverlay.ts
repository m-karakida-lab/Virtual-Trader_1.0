import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { TimeframeSec } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef, TimeToX } from './refs';
import {
  SCRUBBER_TRACK_HEIGHT, SESSION_ROW_GAP, SESSION_ROW_HEIGHT, SESSION_MARKER_GAP, SESSION_MARKER_HEIGHT,
} from './sessionsOverlay';

const TRADE_MARKER_ROW_GAP = 6; // px。下の行（セッション帯 or スクラバー）との間隔
const TAG_HEIGHT = 17; // px。fontSize10px+padding上下1pxの実測値（マーカーからの縦線の起点に使う）

export interface TradeMarkersOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  // マーカーのタグと、タグから価格位置へ伸ばす縦線のDOM要素（キーはマーカーごと）
  elsRef: ReadRef<Map<string, HTMLDivElement>>;
  lineElsRef: ReadRef<Map<string, HTMLDivElement>>;
  timeframeSecRef: ReadRef<TimeframeSec>;
  timeToX: TimeToX;
}

// トレード履歴マーカー（エントリー/決済）をローソク足・インジケータと重ならない
// 専用行にDOM要素で描く。セッション帯のすぐ上（セッション非表示時はスクラバーの
// すぐ上）に積む。番号ラベル付きの小さいタグで、クリックで取引履歴の該当行へ、右クリックでトレード日誌メモ窓を開ける（メモの有無はタグに出さない、幅を食うため）
// （以前のcanvas描画+近似当たり判定は不要になったため撤去した）
export function createSyncTradeMarkers(deps: TradeMarkersOverlayDeps): () => void {
  const { chartRef, seriesRef, overlayRef, elsRef, lineElsRef, timeframeSecRef, timeToX } = deps;
  return () => {
    if (!chartRef.current || !overlayRef.current) return;
    const overlay = overlayRef.current;
    const {
      positions: allPositions, closedTrades: allClosedTrades,
      tradeMarkersVisible: visibleMap, showSessions: sessionsOn, chartBottomMargin: bottomMargin,
    } = useTraderStore.getState();
    const tf = timeframeSecRef.current;
    const visible = visibleMap[tf] !== false;
    overlay.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const tradeNoById = new Map<number, number>();
    [...allClosedTrades].sort((a, b) => a.closeTime - b.closeTime).forEach((t, i) => tradeNoById.set(t.id, i + 1));

    // priceはマーカーからローソク足へ繋ぐ縦線の到達点（そのマーカー自身のエントリー/決済価格）
    type Mark = { key: string; time: number; price: number; color: string; text: string; tradeId: number | null };
    const marks: Mark[] = [];
    for (const pos of allPositions) {
      const isBuy = pos.side === 'BUY';
      marks.push({
        key: `open-${pos.id}`, time: pos.openTime, price: pos.openPrice,
        color: isBuy ? '#26a69a' : '#ef5350', text: pos.side, tradeId: null,
      });
    }
    for (const t of allClosedTrades) {
      const isBuy = t.side === 'BUY';
      const no = tradeNoById.get(t.id);
      marks.push({
        key: `entry-${t.id}`, time: t.openTime, price: t.openPrice,
        color: isBuy ? '#26a69a' : '#ef5350', text: `#${no}`, tradeId: t.id,
      });
      marks.push({
        key: `exit-${t.id}`, time: t.closeTime, price: t.closePrice,
        color: t.pnl >= 0 ? '#26a69a' : '#ef5350',
        text: `#${no}`,
        tradeId: t.id,
      });
    }

    const els = elsRef.current;
    const lineEls = lineElsRef.current;
    const nextKeys = new Set(marks.map(m => m.key));
    for (const [key, el] of els) {
      if (!nextKeys.has(key)) { el.remove(); els.delete(key); }
    }
    for (const [key, el] of lineEls) {
      if (!nextKeys.has(key)) { el.remove(); lineEls.delete(key); }
    }

    // セッション帯が出ている時は、帯そのものではなく現在足の白い縦目印（帯の上端よりさらに
    // 上に出る、sessionsOverlay参照）の上に積む。帯の上端に合わせただけだとその縦目印と
    // 高さが重なって見づらいという指摘を受けた。セッション非表示時はスクラバーのすぐ上
    const sessionsVisible = sessionsOn && tf < 86400;
    const rowBottom = bottomMargin + SCRUBBER_TRACK_HEIGHT + TRADE_MARKER_ROW_GAP
      + (sessionsVisible ? SESSION_ROW_GAP + SESSION_ROW_HEIGHT + SESSION_MARKER_GAP + SESSION_MARKER_HEIGHT : 0);

    for (const m of marks) {
      let el = els.get(m.key);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.transform = 'translateX(-50%)';
        el.style.whiteSpace = 'nowrap';
        el.style.fontSize = '10px';
        el.style.fontWeight = '700';
        el.style.padding = '1px 4px';
        el.style.borderRadius = '2px';
        el.style.pointerEvents = m.tradeId !== null ? 'auto' : 'none';
        if (m.tradeId !== null) {
          el.style.cursor = 'pointer';
          el.title = 'クリック: 履歴の該当行へ / 右クリック: トレード日誌メモ';
          el.onclick = () => useTraderStore.getState().openHistoryForTrade(m.tradeId!);
          el.oncontextmenu = e => { e.preventDefault(); useTraderStore.getState().setMemoTradeId(m.tradeId!); };
        }
        overlay.appendChild(el);
        els.set(m.key, el);
      }
      // マーカーがどの足を指しているか分かるよう、タグからそのエントリー/決済価格の
      // 位置まで縦線で繋ぐ（専用行に移した結果、足との対応が見た目だけでは分からなく
      // なったという指摘を受けて追加）
      let lineEl = lineEls.get(m.key);
      if (!lineEl) {
        lineEl = document.createElement('div');
        lineEl.style.position = 'absolute';
        lineEl.style.width = '1px';
        lineEl.style.pointerEvents = 'none';
        overlay.appendChild(lineEl);
        lineEls.set(m.key, lineEl);
      }
      const x = timeToX(m.time);
      const y = seriesRef.current?.priceToCoordinate(m.price) ?? null;
      if (x === null) {
        el.style.display = 'none';
        lineEl.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.left = `${x}px`;
      el.style.bottom = `${rowBottom}px`;
      el.style.backgroundColor = m.color;
      el.style.color = '#0d0d0d';
      el.textContent = m.text;

      if (y === null) {
        lineEl.style.display = 'none';
      } else {
        lineEl.style.display = 'block';
        lineEl.style.left = `${x}px`;
        lineEl.style.top = `${y}px`;
        lineEl.style.bottom = `${rowBottom + TAG_HEIGHT}px`;
        lineEl.style.backgroundImage = `repeating-linear-gradient(to bottom, ${m.color} 0, ${m.color} 2px, transparent 2px, transparent 5px)`;
        lineEl.style.opacity = '0.6';
      }
    }
  };
}
