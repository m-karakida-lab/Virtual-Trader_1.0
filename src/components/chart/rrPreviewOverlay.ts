import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';

const RR_BOX_WIDTH = 70; // px

export interface RRPreviewOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  tpBoxRef: ReadRef<HTMLDivElement | null>;
  slBoxRef: ReadRef<HTMLDivElement | null>;
  labelRef: ReadRef<HTMLDivElement | null>;
}

// 発注パネルの下書き価格（エントリー/TP/SL）から、現在足の右にTP・SLの幅の箱と
// リスクリワード比を表示する。成行は現在足の終値をエントリー価格とみなす
export function createUpdateRRPreview(deps: RRPreviewOverlayDeps): () => void {
  const { chartRef, seriesRef, overlayRef, tpBoxRef, slBoxRef, labelRef } = deps;
  return () => {
    if (!seriesRef.current || !chartRef.current) return;
    if (!overlayRef.current || !tpBoxRef.current || !slBoxRef.current || !labelRef.current) return;
    const overlay = overlayRef.current;
    const tpBox = tpBoxRef.current;
    const slBox = slBoxRef.current;
    const label = labelRef.current;

    const { orderType: ot, draftPrice: dp, draftTP: dtp, draftSL: dsl, candles: cs, cursor: cur } = useTraderStore.getState();
    const c = cs[cur];
    const entryPrice = ot === 'market' ? c?.close ?? null : dp;

    if (!c || entryPrice === null || (dtp === null && dsl === null)) {
      overlay.style.display = 'none';
      return;
    }

    const x1 = chartRef.current.timeScale().timeToCoordinate(c.time as Time);
    const yEntry = seriesRef.current.priceToCoordinate(entryPrice);
    if (x1 === null || yEntry === null) {
      overlay.style.display = 'none';
      return;
    }
    const x2 = x1 + RR_BOX_WIDTH;
    overlay.style.display = 'block';

    if (dtp !== null) {
      const yTp = seriesRef.current.priceToCoordinate(dtp);
      if (yTp !== null) {
        tpBox.style.display = 'block';
        tpBox.style.left = `${x1}px`;
        tpBox.style.width = `${RR_BOX_WIDTH}px`;
        tpBox.style.top = `${Math.min(yEntry, yTp)}px`;
        tpBox.style.height = `${Math.abs(yTp - yEntry)}px`;
      } else {
        tpBox.style.display = 'none';
      }
    } else {
      tpBox.style.display = 'none';
    }

    if (dsl !== null) {
      const ySl = seriesRef.current.priceToCoordinate(dsl);
      if (ySl !== null) {
        slBox.style.display = 'block';
        slBox.style.left = `${x1}px`;
        slBox.style.width = `${RR_BOX_WIDTH}px`;
        slBox.style.top = `${Math.min(yEntry, ySl)}px`;
        slBox.style.height = `${Math.abs(ySl - yEntry)}px`;
      } else {
        slBox.style.display = 'none';
      }
    } else {
      slBox.style.display = 'none';
    }

    if (dtp !== null && dsl !== null) {
      const risk = Math.abs(entryPrice - dsl);
      const reward = Math.abs(dtp - entryPrice);
      const ratio = risk > 0 ? reward / risk : 0;
      label.textContent = `R:R 1 : ${ratio.toFixed(2)}`;
      label.style.display = 'block';
      label.style.left = `${x2 + 6}px`;
      label.style.top = `${yEntry}px`;
    } else {
      label.style.display = 'none';
    }
  };
}
