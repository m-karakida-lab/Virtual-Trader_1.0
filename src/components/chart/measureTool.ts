import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Candle } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';
import { createUpdateMeasureBox, type MeasureStart } from './measureOverlay';
import { lockChartForDrag, unlockChartAfterDrag, type DragSession } from './drag';

export interface MeasureToolDeps {
  chart: IChartApi;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  boxRef: ReadRef<HTMLDivElement | null>;
  midLineRef: ReadRef<HTMLDivElement | null>;
  labelRef: ReadRef<HTMLDivElement | null>;
  displayCandlesRef: ReadRef<Candle[]>;
}

// ものさし（ドラッグで価格差・pips・%・本数・期間を計測）。「ものさし」ツール選択中の左ドラッグと、
// ツール選択に関わらず使えるホイールクリック（中央ボタン）ドラッグの両方から開始する。
// 1回計測したら自動的に解除する（連続測定にはしない）
export function createMeasureTool(deps: MeasureToolDeps): { start: (x: number, y: number) => DragSession | null } {
  const { chart, seriesRef, overlayRef, displayCandlesRef } = deps;
  let measureStart: MeasureStart | null = null;
  const updateMeasureBox = createUpdateMeasureBox({
    chartRef: { current: chart }, seriesRef, overlayRef, boxRef: deps.boxRef, midLineRef: deps.midLineRef,
    labelRef: deps.labelRef, displayCandlesRef, getMeasureStart: () => measureStart,
  });
  return {
    start: (x, y) => {
      if (!seriesRef.current) return null;
      const price = seriesRef.current.coordinateToPrice(y);
      const time = chart.timeScale().coordinateToTime(x);
      if (price === null || time === null) return null;
      const start = { x, y, price, time: time as number };
      measureStart = start;
      lockChartForDrag(chart);
      updateMeasureBox(x, y, x, y);
      return {
        move(mx, my) {
          updateMeasureBox(start.x, start.y, mx, my);
        },
        end() {
          unlockChartAfterDrag(chart);
          // ホイールクリックでの計測はもともとisMeasuring=falseなのでsetStateは実質no-op、表示だけ
          // 明示的に隠す（React effectはisMeasuringの変化でしか発火せず、false→falseでは反応しないため）
          useTraderStore.setState({ isMeasuring: false });
          if (overlayRef.current) overlayRef.current.style.display = 'none';
        },
      };
    },
  };
}
