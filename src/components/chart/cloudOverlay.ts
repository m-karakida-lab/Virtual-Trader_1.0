import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Candle } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';
import { beginCanvasFrame, type CutCandles } from './canvas';

export type CloudPoint = { time: number; a: number; b: number };

export interface CloudOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  canvasRef: ReadRef<HTMLCanvasElement | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  // 先行スパンA/Bの点列（CandleChart側のeffectが足の更新時に差し替える）
  cloudDataRef: ReadRef<CloudPoint[]>;
  cutCandlesFromCanvas: CutCandles;
}

// 一目均衡表の雲（先行スパンA/B）の塗りつぶしをcanvasに描く。境界線自体はlineSeries
export function createSyncCloud(deps: CloudOverlayDeps): () => void {
  const { chartRef, seriesRef, canvasRef, displayCandlesRef, cloudDataRef, cutCandlesFromCanvas } = deps;
  return () => {
    const canvas = canvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w } = frame;

    const { showCloud: show, overlaysHidden: hidden } = useTraderStore.getState();
    const cs = displayCandlesRef.current;
    const points = cloudDataRef.current;
    if (!show || hidden || points.length < 2) return;

    const timeScale = chartRef.current.timeScale();
    const series = seriesRef.current;
    // 表示範囲がローソク足の実データより外側に及んでいても、雲は最初の足より左側には描画しない
    // （timeToCoordinate は範囲外の時刻も外挿してしまうため）
    const leftBoundX = cs.length > 0 ? timeScale.timeToCoordinate(cs[0].time as Time) : null;
    // 全点（数万）を毎回なぞると再生中の毎ステップが間に合わないので、画面に入る範囲だけ描く。
    // 左端は表示範囲の左端の足の時刻以降を二分探索、右端はxが幅を超えた所で打ち切る
    let startIdx = 0;
    const range = timeScale.getVisibleLogicalRange();
    if (range && cs.length > 0) {
      const leftTime = cs[Math.min(cs.length - 1, Math.max(0, Math.floor(range.from) - 1))].time;
      let lo = 0, hi = points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].time < leftTime) lo = mid + 1; else hi = mid;
      }
      startIdx = Math.max(0, lo - 1);
    }
    for (let i = startIdx; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const x0 = timeScale.timeToCoordinate(p0.time as Time);
      const x1 = timeScale.timeToCoordinate(p1.time as Time);
      if (x0 === null || x1 === null) continue;
      if (x0 > w) break;
      if (leftBoundX !== null && x1 <= leftBoundX) continue;
      const ya0 = series.priceToCoordinate(p0.a);
      const ya1 = series.priceToCoordinate(p1.a);
      const yb0 = series.priceToCoordinate(p0.b);
      const yb1 = series.priceToCoordinate(p1.b);
      if (ya0 === null || ya1 === null || yb0 === null || yb1 === null) continue;

      ctx.fillStyle = (p0.a + p1.a) >= (p0.b + p1.b) ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)';
      ctx.beginPath();
      ctx.moveTo(x0, ya0);
      ctx.lineTo(x1, ya1);
      ctx.lineTo(x1, yb1);
      ctx.lineTo(x0, yb0);
      ctx.closePath();
      ctx.fill();
    }

    // 塗りつぶしはSeriesではなくこのcanvasへの直接描画なので、Seriesの順序ではロウソク足を
    // 上に出せない。四角形・垂直線と同じdestination-outでロウソク足の位置だけ透明に抜く
    cutCandlesFromCanvas(ctx, w);
  };
}
