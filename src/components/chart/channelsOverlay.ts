import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { beginCanvasFrame } from './canvas';
import { drawMidpointHandle, drawTrendLineShape, type PxSegment, type TwoPointDrag } from './trendLinesOverlay';

export interface ChannelsOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  timeToX: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  // ドラッグ中（端点リサイズ・平行移動・オフセット調整）の既存チャネル
  getDragPreview: Getter<(TwoPointDrag & { offset: number }) | null>;
  // 新規描画中（基準線のドラッグ中、まだstoreに存在しない）の線分。ピクセル座標のみ
  getNewDraft: Getter<PxSegment | null>;
  // 基準線が確定し、オフセットを決めるクリック待ちの基準線と、その間のマウス位置による
  // オフセット（価格差）のプレビュー
  getAwaitingOffset: Getter<Omit<TwoPointDrag, 'id'> | null>;
  getOffsetPreview: Getter<number | null>;
}

// 平行チャネル（基準線＋価格オフセットした2本目の平行線）
export function createSyncChannels(deps: ChannelsOverlayDeps): () => void {
  const {
    chartRef, seriesRef, canvasRef, timeToX, getVisibleDrawings,
    getDragPreview, getNewDraft, getAwaitingOffset, getOffsetPreview,
  } = deps;
  return () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w, h } = frame;
    const series = seriesRef.current;

    const { selected, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const { channels: visibleChannels } = getVisibleDrawings();
    const selectedChannelId = selected?.kind === 'channel' ? selected.id : null;
    const dragPreview = getDragPreview();
    const newDraft = getNewDraft();
    const awaitingOffset = getAwaitingOffset();

    // トレンドラインと同じ理由・同じ方式で日付軸欄の手前までにクリップする
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h - bottomMargin);
    ctx.clip();

    for (const ch of visibleChannels) {
      const live = dragPreview && dragPreview.id === ch.id ? dragPreview : ch;
      const x1 = timeToX(live.time1);
      const x2 = timeToX(live.time2);
      const y1 = series.priceToCoordinate(live.price1);
      const y2 = series.priceToCoordinate(live.price2);
      const y1b = series.priceToCoordinate(live.price1 + live.offset);
      const y2b = series.priceToCoordinate(live.price2 + live.offset);
      if (x1 === null || x2 === null || y1 === null || y2 === null || y1b === null || y2b === null) continue;
      const isSelected = ch.id === selectedChannelId;
      // 基準線を掴んで選択した時は端点ハンドル付き。オフセット線（2本目）を掴んで選択した
      // 時は、オフセット線側に水平線と同じ中点ハンドルを出す（オフセット線は本体ドラッグでの
      // 幅調整しかできないため、「選択中である」ことだけを示す）
      const selectedPart = isSelected && selected?.kind === 'channel' ? (selected.part ?? 'base') : null;
      drawTrendLineShape(ctx, x1, y1, x2, y2, ch.color, ch.dash, ch.width, selectedPart === 'base');
      drawTrendLineShape(ctx, x1, y1b, x2, y2b, ch.color, ch.dash, ch.width, false);
      if (selectedPart === 'offset') drawMidpointHandle(ctx, (x1 + x2) / 2, (y1b + y2b) / 2);
    }

    if (awaitingOffset) {
      const { channelDraft } = useTraderStore.getState();
      const { time1, price1, time2, price2 } = awaitingOffset;
      const offset = getOffsetPreview() ?? 0;
      const x1 = timeToX(time1), x2 = timeToX(time2);
      const y1 = series.priceToCoordinate(price1), y2 = series.priceToCoordinate(price2);
      const y1b = series.priceToCoordinate(price1 + offset), y2b = series.priceToCoordinate(price2 + offset);
      if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) {
        drawTrendLineShape(ctx, x1, y1, x2, y2, channelDraft.color, channelDraft.dash, channelDraft.width, false);
        if (y1b !== null && y2b !== null) drawTrendLineShape(ctx, x1, y1b, x2, y2b, channelDraft.color, channelDraft.dash, channelDraft.width, false);
      }
    } else if (newDraft) {
      const { channelDraft } = useTraderStore.getState();
      const { x1, y1, x2, y2 } = newDraft;
      drawTrendLineShape(ctx, x1, y1, x2, y2, channelDraft.color, channelDraft.dash, channelDraft.width, false);
    }
    ctx.restore();
  };
}
