import { useEffect } from 'react';
import { LineStyle, type CreatePriceLineOptions, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import type { Candle, OrderType, PendingOrder, Position } from '../../types';
import { inferPipSize } from '../../lib/pips';
import { logError } from '../../lib/errorLog';
import type { ReadRef } from './refs';

// TP/SLの価格ライン表示用: エントリー価格からの距離をpips単位で返す
function pipsBetween(entryPrice: number, target: number): number {
  return Math.abs(target - entryPrice) / inferPipSize(entryPrice);
}

// キーごとの価格ラインをwantedの内容に合わせる（無くなったキーは削除、既存はapplyOptions、新規はcreate）
function syncPriceLines<K>(
  series: ISeriesApi<'Candlestick'>,
  existing: Map<K, IPriceLine>,
  wanted: { key: K; opts: CreatePriceLineOptions }[],
) {
  const keys = new Set(wanted.map(w => w.key));
  for (const [key, pl] of existing) {
    if (!keys.has(key)) { series.removePriceLine(pl); existing.delete(key); }
  }
  for (const { key, opts } of wanted) {
    const cur = existing.get(key);
    if (cur) cur.applyOptions(opts);
    else existing.set(key, series.createPriceLine(opts));
  }
}

const tpOpts = (price: number, entry: number): CreatePriceLineOptions => ({
  price, color: '#26a69a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
  title: `TP ${pipsBetween(entry, price).toFixed(1)}p`,
});
const slOpts = (price: number, entry: number): CreatePriceLineOptions => ({
  price, color: '#ef5350', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
  title: `SL ${pipsBetween(entry, price).toFixed(1)}p`,
});

export interface PriceLineMaps {
  orderLineMapRef: ReadRef<Map<number, IPriceLine>>;
  orderTpLineMapRef: ReadRef<Map<number, IPriceLine>>;
  orderSlLineMapRef: ReadRef<Map<number, IPriceLine>>;
  tpLineMapRef: ReadRef<Map<number, IPriceLine>>;
  slLineMapRef: ReadRef<Map<number, IPriceLine>>;
  positionEntryLineMapRef: ReadRef<Map<number, IPriceLine>>;
  draftLineMapRef: ReadRef<Map<'price' | 'tp' | 'sl', IPriceLine>>;
}

export interface PriceLinesState {
  pendingOrders: PendingOrder[];
  positions: Position[];
  orderType: OrderType;
  draftPrice: number | null;
  draftTP: number | null;
  draftSL: number | null;
  candles: Candle[];
  cursor: number;
}

// 未約定注文・ポジション（エントリー/TP/SL）・発注パネルの下書き価格をlightweight-chartsの
// 価格ライン（createPriceLine）で表示する。マップ自体はドラッグ移動とチャート破棄時の
// clear()でも使うためCandleChart側が持ち、ここは中身の同期だけを行う
export function usePriceLines(
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>,
  maps: PriceLineMaps,
  state: PriceLinesState,
) {
  const { pendingOrders, positions, orderType, draftPrice, draftTP, draftSL, candles, cursor } = state;

  // 未約定注文（指値・逆指値）の価格ライン
  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      syncPriceLines(seriesRef.current, maps.orderLineMapRef.current, pendingOrders.map(o => ({
        key: o.id,
        opts: {
          price: o.price,
          color: o.side === 'BUY' ? '#42a5f5' : '#ab47bc',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${o.side} ${o.type === 'limit' ? 'LIMIT' : 'STOP'}`,
        },
      })));
    } catch (e) {
      logError('CandleChart:orderLines', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOrders]);

  // 未約定注文に紐づく TP / SL の価格ライン（約定前から表示）
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
      syncPriceLines(series, maps.orderTpLineMapRef.current, pendingOrders.filter(o => o.tp !== undefined)
        .map(o => ({ key: o.id, opts: tpOpts(o.tp!, o.price) })));
      syncPriceLines(series, maps.orderSlLineMapRef.current, pendingOrders.filter(o => o.sl !== undefined)
        .map(o => ({ key: o.id, opts: slOpts(o.sl!, o.price) })));
    } catch (e) {
      logError('CandleChart:orderTpSlLines', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOrders]);

  // ポジションの TP / SL 価格ライン
  useEffect(() => {
    if (!seriesRef.current) return;
    const series = seriesRef.current;
    try {
      syncPriceLines(series, maps.tpLineMapRef.current, positions.filter(p => p.tp !== undefined)
        .map(p => ({ key: p.id, opts: tpOpts(p.tp!, p.openPrice) })));
      syncPriceLines(series, maps.slLineMapRef.current, positions.filter(p => p.sl !== undefined)
        .map(p => ({ key: p.id, opts: slOpts(p.sl!, p.openPrice) })));
    } catch (e) {
      logError('CandleChart:tpSlLines', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  // ポジションのエントリー価格ライン
  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      syncPriceLines(seriesRef.current, maps.positionEntryLineMapRef.current, positions.map(p => ({
        key: p.id,
        opts: {
          price: p.openPrice,
          color: p.side === 'BUY' ? '#42a5f5' : '#ab47bc',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${p.side} ${p.lots}`,
        },
      })));
    } catch (e) {
      logError('CandleChart:positionEntryLines', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  // 発注パネルの draft 価格（price/TP/SL）のプレビュー（ドット線で確定済みと区別）
  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      // pips表示の基準となるエントリー価格: 成行は現在値、指値/逆指値はdraftPrice（未入力ならnullのまま表示なし）
      const draftEntryPrice = orderType === 'market' ? candles[cursor]?.close ?? null : draftPrice;

      const wanted: { key: 'price' | 'tp' | 'sl'; price: number; color: string; title: string }[] = [];
      if (orderType !== 'market' && draftPrice !== null) {
        wanted.push({ key: 'price', price: draftPrice, color: '#888', title: '指値/逆指値 (draft)' });
      }
      if (draftTP !== null) {
        const pips = draftEntryPrice !== null ? ` ${pipsBetween(draftEntryPrice, draftTP).toFixed(1)}p` : '';
        wanted.push({ key: 'tp', price: draftTP, color: '#26a69a', title: `TP (draft)${pips}` });
      }
      if (draftSL !== null) {
        const pips = draftEntryPrice !== null ? ` ${pipsBetween(draftEntryPrice, draftSL).toFixed(1)}p` : '';
        wanted.push({ key: 'sl', price: draftSL, color: '#ef5350', title: `SL (draft)${pips}` });
      }

      syncPriceLines(seriesRef.current, maps.draftLineMapRef.current, wanted.map(w => ({
        key: w.key,
        opts: { price: w.price, color: w.color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: w.title },
      })));
    } catch (e) {
      logError('CandleChart:draftLines', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderType, draftPrice, draftTP, draftSL, candles, cursor]);
}
