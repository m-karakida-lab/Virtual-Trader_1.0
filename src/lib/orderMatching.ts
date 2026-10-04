import type { Candle, Position, PendingOrder, ClosedTrade } from '../types';

// 通過したローソク足の範囲（fromIdx は除外、toIdx は含む）について
// 未約定注文の約定判定・オープン中ポジションの TP/SL 判定を行う。
// 高値・安値がレベルを跨いだら約定（始値ベースではなく範囲ベースで判定）。
export function processOrderRange(
  candles: Candle[],
  fromIdx: number,
  toIdx: number,
  positions: Position[],
  pendingOrders: PendingOrder[],
  closedTrades: ClosedTrade[],
  balance: number,
  nextId: number,
): { positions: Position[]; pendingOrders: PendingOrder[]; closedTrades: ClosedTrade[]; balance: number; nextId: number; changed: boolean } {
  let changed = false;

  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const c = candles[i];
    if (!c) break;

    if (pendingOrders.length > 0) {
      const stillPending: PendingOrder[] = [];
      for (const order of pendingOrders) {
        if (c.low <= order.price && order.price <= c.high) {
          positions = [...positions, {
            id: nextId, side: order.side, openPrice: order.price,
            lots: order.lots, openTime: c.time, tp: order.tp, sl: order.sl, rrImage: order.rrImage,
          }];
          nextId += 1;
          changed = true;
        } else {
          stillPending.push(order);
        }
      }
      pendingOrders = stillPending;
    }

    if (positions.length > 0) {
      const stillOpen: Position[] = [];
      for (const pos of positions) {
        // SL を先に判定する（同一バーで TP/SL 両方ヒットした場合は不利な方を優先）
        let exitPrice: number | undefined;
        if (pos.side === 'BUY') {
          if (pos.sl !== undefined && c.low <= pos.sl) exitPrice = pos.sl;
          else if (pos.tp !== undefined && c.high >= pos.tp) exitPrice = pos.tp;
        } else {
          if (pos.sl !== undefined && c.high >= pos.sl) exitPrice = pos.sl;
          else if (pos.tp !== undefined && c.low <= pos.tp) exitPrice = pos.tp;
        }
        if (exitPrice !== undefined) {
          const dir = pos.side === 'BUY' ? 1 : -1;
          const pnl = (exitPrice - pos.openPrice) * pos.lots * dir;
          balance += pnl;
          closedTrades = [...closedTrades, {
            id: pos.id, side: pos.side, openPrice: pos.openPrice, closePrice: exitPrice,
            openTime: pos.openTime, closeTime: c.time, lots: pos.lots, pnl,
            tp: pos.tp, sl: pos.sl, rrImage: pos.rrImage,
          }];
          changed = true;
        } else {
          stillOpen.push(pos);
        }
      }
      positions = stillOpen;
    }
  }

  return { positions, pendingOrders, closedTrades, balance, nextId, changed };
}
