import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle } from '../../types';
import { inferPipSize, pricePrecision } from '../../lib/pips';
import type { Getter, ReadRef } from './refs';
import { candleIndexAt } from './candleIndex';

function fmtDuration(sec: number): string {
  const abs = Math.abs(sec);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((abs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export type MeasureStart = { x: number; y: number; price: number; time: number };

export interface MeasureOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  boxRef: ReadRef<HTMLDivElement | null>;
  midLineRef: ReadRef<HTMLDivElement | null>;
  labelRef: ReadRef<HTMLDivElement | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  // ドラッグ開始点（開始・終了の判定はCandleChart側のマウス処理が持つ）
  getMeasureStart: Getter<MeasureStart | null>;
}

// ものさし（ドラッグで価格差・pips・%・本数・期間を計測）の箱とラベルを更新する
export function createUpdateMeasureBox(deps: MeasureOverlayDeps) {
  const { chartRef, seriesRef, overlayRef, boxRef, midLineRef, labelRef, displayCandlesRef, getMeasureStart } = deps;
  return (x1: number, y1: number, x2: number, y2: number) => {
    const measureStart = getMeasureStart();
    if (!overlayRef.current || !boxRef.current || !labelRef.current) return;
    if (!measureStart || !seriesRef.current || !chartRef.current) return;
    const overlay = overlayRef.current;
    const box = boxRef.current;
    const label = labelRef.current;

    const endPrice = seriesRef.current.coordinateToPrice(y2);
    const endTime = chartRef.current.timeScale().coordinateToTime(x2);
    if (endPrice === null) return;

    overlay.style.display = 'block';

    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    // 色・符号はドラッグの始点→終点（下から上にドラッグしたら＋）で決める。
    // 画面左→右（時系列順）で決めると、時間方向にわずかでも逆行しただけで
    // 上方向にドラッグしたのに赤（マイナス）表示になってしまう
    const priceDiff = endPrice - measureStart.price;
    const pct = (priceDiff / measureStart.price) * 100;
    const up = priceDiff >= 0;
    const color = up ? '#26a69a' : '#ef5350';

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.border = `1px solid ${color}`;
    box.style.backgroundColor = up ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';

    // 上下の中央線（始点・終点価格の中間値を示す横線）
    if (midLineRef.current) {
      const mid = midLineRef.current;
      mid.style.display = 'block';
      mid.style.left = `${left}px`;
      mid.style.top = `${(y1 + y2) / 2}px`;
      mid.style.width = `${width}px`;
      mid.style.borderTop = `1px dashed ${color}`;
    }

    let barText = '';
    if (endTime !== null) {
      const cs = displayCandlesRef.current;
      if (cs.length > 0) {
        const bars = Math.abs(candleIndexAt(cs, endTime as number) - candleIndexAt(cs, measureStart.time));
        const dur = fmtDuration((endTime as number) - measureStart.time);
        barText = `${bars}本 · ${dur}`;
      }
    }

    const pipSize = inferPipSize(measureStart.price);
    const pips = priceDiff / pipSize;

    label.innerHTML = '';
    const priceLine = document.createElement('div');
    priceLine.style.color = color;
    priceLine.style.fontWeight = '700';
    priceLine.style.fontSize = '16px';
    priceLine.textContent = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(pricePrecision(measureStart.price))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    const pipsLine = document.createElement('div');
    pipsLine.style.color = color;
    pipsLine.style.fontSize = '14px';
    pipsLine.style.marginTop = '2px';
    pipsLine.textContent = `${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips`;
    const barLine = document.createElement('div');
    barLine.style.color = '#aaa';
    barLine.style.fontSize = '14px';
    barLine.style.marginTop = '2px';
    barLine.textContent = barText;
    label.appendChild(priceLine);
    label.appendChild(pipsLine);
    label.appendChild(barLine);

    label.style.display = 'block';
    label.style.left = `${x2 + 8}px`;
    label.style.top = `${y2}px`;
  };
}
