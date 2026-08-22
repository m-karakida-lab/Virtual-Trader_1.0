import { useEffect, useRef, useState } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useTraderStore } from '../store/useTraderStore';
import type { Candle, TimeframeSec } from '../types';
import { initDuckDB, queryCandles } from '../lib/duckdb';
import { pricePrecision } from '../lib/pips';
import { CHART_FONT_FAMILY, CHART_AXIS_TEXT_COLOR, CHART_AXIS_FONT_SIZE } from '../lib/chartTheme';
import { ChartHeader } from './ChartHeader';
import { loadChartView, saveChartView, relativeViewToLogicalRange } from '../lib/chartViewState';

const toBar = (c: Candle) => ({
  time: c.time as Time,
  open: c.open, high: c.high, low: c.low, close: c.close,
});

// 4画面レイアウトの表示専用サブパネル。発注・描画などの操作はできず、
// メインチャートのカーソル時刻までに切り詰めて表示するだけ。
export function MiniChart({ timeframeSec, label }: { timeframeSec: TimeframeSec; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [data, setData] = useState<Candle[]>([]);

  const isLoaded = useTraderStore(s => s.isLoaded);
  const dataVersion = useTraderStore(s => s.dataVersion);
  const cursorTime = useTraderStore(s => s.candles[s.cursor]?.time);
  const mainTimeframeSec = useTraderStore(s => s.timeframeSec);
  const symbol = useTraderStore(s => s.symbol);
  const showFullHistory = useTraderStore(s => s.showFullHistory);
  // メインの現在足が閉じた時点（=これより先の情報は「未来」として隠す境界）
  const cursorEnd = cursorTime !== undefined ? cursorTime + mainTimeframeSec : undefined;

  // CSV読み込み完了のたびに、この時間軸で自前集計
  useEffect(() => {
    if (!isLoaded) { setData([]); return; }
    let cancelled = false;
    (async () => {
      const db = await initDuckDB();
      const candles = await queryCandles(db, timeframeSec);
      if (!cancelled) setData(candles);
    })();
    return () => { cancelled = true; };
  }, [isLoaded, dataVersion, timeframeSec]);

  // チャート初期化（マウント時1回）
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const chart = createChart(container, {
      layout: {
        background: { color: '#0d0d0d' },
        textColor: CHART_AXIS_TEXT_COLOR,
        fontSize: CHART_AXIS_FONT_SIZE,
        fontFamily: CHART_FONT_FAMILY,
      },
      grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
      crosshair: { vertLine: { color: '#333' }, horzLine: { color: '#333' } },
      rightPriceScale: { borderColor: '#1e1e1e' },
      localization: { locale: 'en-US', dateFormat: 'yy MM/dd' },
      timeScale: {
        borderColor: '#1e1e1e',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => {
          const d = new Date((time as number) * 1000);
          const M = d.getUTCMonth() + 1;
          const D = d.getUTCDate();
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const mm = String(d.getUTCMinutes()).padStart(2, '0');
          const yy = String(d.getUTCFullYear()).slice(2);
          return d.getUTCHours() === 0 && d.getUTCMinutes() === 0
            ? `${yy} ${M}/${D}`
            : `${hh}:${mm}`;
        },
      },
      handleScroll: true,
      handleScale: true,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderUpColor: '#26a69a', borderDownColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    ro.observe(container);

    // 表示中のズーム/スケールを時間軸ごとに記憶（連続発火するため軽くデバウンス）
    let saveViewTimer: number | undefined;
    const onRangeChange = () => {
      if (saveViewTimer !== undefined) window.clearTimeout(saveViewTimer);
      saveViewTimer = window.setTimeout(() => {
        if (!chartRef.current) return;
        const range = chartRef.current.timeScale().getVisibleLogicalRange();
        if (!range || visibleCountRef.current <= 0) return;
        saveChartView(timeframeSec, { span: range.to - range.from, barsFromRight: visibleCountRef.current - range.to });
      }, 400);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    return () => {
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      if (saveViewTimer !== undefined) window.clearTimeout(saveViewTimer);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [timeframeSec]);

  // 新しいデータセットに切り替わった時だけ画面フィットしたか（同じデータ中はスケールを保持する）
  const fittedDataRef = useRef<Candle[] | null>(null);
  const visibleCountRef = useRef(0);

  // データ・カーソル位置に応じて描画。バケット終了時刻がメインの現在足の終了時刻を
  // 超える（＝まだ閉じていない）足は先出しになるため描画しない
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;
    const visible = showFullHistory || cursorEnd === undefined
      ? data
      : data.filter(c => c.time + timeframeSec <= cursorEnd);
    if (visible.length === 0) return;

    const precision = pricePrecision(visible[visible.length - 1].close);
    seriesRef.current.applyOptions({
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    seriesRef.current.setData(visible.map(toBar));
    visibleCountRef.current = visible.length;

    // カーソル進行のたびに毎回フィットすると、序盤の少数本だけを見て過剰拡大されるため、
    // 新規データ読み込み時（全期間の時間幅）だけ一度フィットし、以降は同じスケールを維持する。
    // 記憶済みのズーム/スケールがあればそちらを優先して復元する
    if (fittedDataRef.current !== data) {
      fittedDataRef.current = data;
      const saved = loadChartView(timeframeSec);
      if (saved) {
        chartRef.current?.timeScale().setVisibleLogicalRange(relativeViewToLogicalRange(saved, visible.length));
      } else {
        chartRef.current?.timeScale().setVisibleRange({
          from: data[0].time as Time,
          to: data[data.length - 1].time as Time,
        });
      }
    }
  }, [data, cursorEnd, showFullHistory]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', border: '1px solid #1e1e1e', minWidth: 0, minHeight: 0 }}>
      <ChartHeader symbol={symbol} timeframeLabel={label} />
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
