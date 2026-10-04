import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Candle } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef, TimeToX } from './refs';
import { candleIndexAt } from './candleIndex';

const MAGNET_WEAK_PX = 12;

// 点(px,py)から線分(x1,y1)-(x2,y2)までの最短距離
export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 直線(time1,price1)-(time2,price2)を時間方向に延長した直線上で、atTime時点の価格を返す
// （平行チャネルのオフセット確定クリック時、基準線から見た価格差を求めるのに使う）
export function interpolatePriceOnLine(time1: number, price1: number, time2: number, price2: number, atTime: number): number {
  if (time2 === time1) return price1;
  const t = (atTime - time1) / (time2 - time1);
  return price1 + t * (price2 - price1);
}

export interface CoordinateDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  effectiveCursorRef: ReadRef<number>;
  isMainRef: ReadRef<boolean>;
  nonMainCandlesRef: ReadRef<Candle[]>;
  timeframeSecRef: ReadRef<number>;
  timeToX: TimeToX;
}

// マウス座標→時刻・価格の変換（描画・編集のマウス処理が使う）
export function createCoordinateHelpers(deps: CoordinateDeps) {
  const { chartRef, seriesRef, displayCandlesRef, effectiveCursorRef, isMainRef, nonMainCandlesRef, timeframeSecRef, timeToX } = deps;

  // 開示済みの最後の足より右（未来の空き領域）のX座標を時刻へ変換する。そこにはseriesのデータが
  // 無くcoordinateToTimeがnullを返すため、最後の足の座標とbarSpacingから足の番号を求め、
  // 全期間の足の並びから時刻を引く（並びの外側はtimeframe間隔で外挿。timeToXの逆変換）。
  // snap=trueは足の位置へ丸める。未来領域でなければnull
  const futureTimeAt = (x: number, snap: boolean): number | null => {
    if (!chartRef.current) return null;
    const dc = displayCandlesRef.current;
    const lastIdx = Math.min(dc.length - 1, effectiveCursorRef.current);
    if (lastIdx < 0) return null;
    const ts = chartRef.current.timeScale();
    const lastX = ts.timeToCoordinate(dc[lastIdx].time as Time);
    if (lastX === null || x <= lastX) return null;
    let idx = lastIdx + (x - lastX) / ts.options().barSpacing;
    if (snap) idx = Math.round(idx);
    const full = isMainRef.current ? dc : nonMainCandlesRef.current;
    if (full.length === 0) return null;
    if (idx >= full.length - 1) return full[full.length - 1].time + (idx - (full.length - 1)) * timeframeSecRef.current;
    const lo = Math.floor(idx);
    return full[lo].time + (idx - lo) * (full[lo + 1].time - full[lo].time);
  };

  // 四角形の頂点等のX座標→時刻変換。lightweight-chartsのcoordinateToTimeをそのまま使う
  // （足に吸着する＝ドラッグ幅が1本未満だと細くなるが、それ自体は仕様として許容する）。
  // 唯一のクランプは「実際に表示されている足（リプレイ中ならcursorまで）の範囲より外側は
  // nullが返る」ケースだけで、その場合は表示中の最初/最後の足の時刻に丸める
  const pixelToTime = (x: number): number | null => {
    if (!chartRef.current) return null;
    const ts = chartRef.current.timeScale();
    const t = ts.coordinateToTime(x);
    if (t !== null) return t as number;
    const future = futureTimeAt(x, true);
    if (future !== null) return future;
    const visible = displayCandlesRef.current;
    if (visible.length === 0) return null;
    const firstX = ts.timeToCoordinate(visible[0].time as Time);
    const lastX = ts.timeToCoordinate(visible[visible.length - 1].time as Time);
    if (firstX !== null && x <= firstX) return visible[0].time;
    if (lastX !== null && x >= lastX) return visible[visible.length - 1].time;
    return null;
  };

  // ブラシ専用の連続的なピクセル→時刻変換。pixelToTimeは足の内側ではその足の時刻へ
  // スナップしてしまい、1本の足の幅の中で何度もサンプリングするブラシは線が階段状に
  // カクつく。timeToXの逆変換として、表示中の足を挟む2本の間で線形補間して連続値を得る
  // （timeToXと同じくts.timeToCoordinateだけを使う。coordinateToLogicalは不安定で使わない）
  const pixelToContinuousTime = (x: number): number | null => {
    if (!chartRef.current) return null;
    const ts = chartRef.current.timeScale();
    const future = futureTimeAt(x, false);
    if (future !== null) return future;
    const visible = displayCandlesRef.current;
    if (visible.length === 0) return null;
    const firstX = ts.timeToCoordinate(visible[0].time as Time);
    const lastX = ts.timeToCoordinate(visible[visible.length - 1].time as Time);
    if (firstX === null || lastX === null) return pixelToTime(x);
    if (x <= firstX) return visible[0].time;
    if (x >= lastX) return visible[visible.length - 1].time;
    let lo = 0, hi = visible.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const midX = ts.timeToCoordinate(visible[mid].time as Time);
      if (midX !== null && midX <= x) lo = mid; else hi = mid;
    }
    const x0 = ts.timeToCoordinate(visible[lo].time as Time);
    const x1 = ts.timeToCoordinate(visible[hi].time as Time);
    if (x0 === null || x1 === null || x1 === x0) return visible[lo].time;
    const frac = (x - x0) / (x1 - x0);
    return visible[lo].time + frac * (visible[hi].time - visible[lo].time);
  };

  // カーソル座標(x,y)を、マグネット設定に応じて直下の足の始値/高値/安値/終値のうち
  // 最も近いものへ吸着させる。strong は常に吸着、weak は MAGNET_WEAK_PX 以内に
  // 近づいた時だけ吸着、off は素通し。吸着後の価格とそのy座標を返す
  // （プレビュー描画はピクセル単位で行われるため、価格だけでなくyも一緒に返す）
  const magnetSnap = (x: number, y: number): { price: number; y: number } | null => {
    if (!seriesRef.current) return null;
    const rawPrice = seriesRef.current.coordinateToPrice(y);
    if (rawPrice === null) return null;
    const { magnetMode } = useTraderStore.getState();
    const visible = displayCandlesRef.current;
    if (magnetMode === 'off' || visible.length === 0) return { price: rawPrice, y };
    const t = pixelToTime(x);
    if (visible.length === 0 || t === null) return { price: rawPrice, y };
    const idx0 = Math.min(Math.max(candleIndexAt(visible, t), 0), visible.length - 1);
    let best = idx0, bestDx = Infinity;
    for (const i of [idx0, idx0 + 1]) {
      if (i < 0 || i >= visible.length) continue;
      const cx = timeToX(visible[i].time);
      if (cx === null) continue;
      const dx = Math.abs(cx - x);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    const c = visible[best];
    let snappedPrice: number = rawPrice, snappedY = y, bestDy = Infinity;
    for (const v of [c.open, c.high, c.low, c.close]) {
      const vy = seriesRef.current.priceToCoordinate(v);
      if (vy === null) continue;
      const dy = Math.abs(vy - y);
      if (dy < bestDy) { bestDy = dy; snappedPrice = v; snappedY = vy; }
    }
    if (magnetMode === 'weak' && bestDy > MAGNET_WEAK_PX) return { price: rawPrice, y };
    return { price: snappedPrice, y: snappedY };
  };

  return { pixelToTime, pixelToContinuousTime, magnetSnap };
}
