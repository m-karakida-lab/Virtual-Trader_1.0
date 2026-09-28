import { useEffect, useRef } from 'react';
import type { ISeriesApi, LineData, Time } from 'lightweight-charts';
import type { Candle } from '../../types';
import { cloudDisplacedTime } from '../../lib/indicators';
import type { ReadRef } from './refs';
import type { CloudPoint } from './cloudOverlay';

const EMA_PERIOD = 200;
const SMA_PERIOD = 14;
const BB_PERIOD = 20;
// 一目均衡表「雲」（先行スパンA/B）
const TENKAN_PERIOD = 9;
const KIJUN_PERIOD = 26;
const SENKOU_B_PERIOD = 52;

// インジケータの本来の線色。overlaysHidden時はvisible:falseにせず、この色→透明の
// 切替だけで隠す（visible:falseにすると当該シリーズがオートスケール計算から除外され、
// ローソク足の縦スケールが一瞬でジャンプして見えるため。データ・座標計算は裏で継続し、
// 見た目の色だけを消す）。シリーズ生成時（CandleChartのマウントeffect）も同じ色を使う
export const EMA_COLOR = '#ffa726';
export const SMA_COLOR = '#ab47bc';
export const BB_BASIS_COLOR = '#42a5f5';
export const BB_SILVER = '#c0c0c0';
export const CLOUD_A_COLOR = '#26a69a';
export const CLOUD_B_COLOR = '#ef5350';
const TRANSPARENT = 'rgba(0,0,0,0)';

// 直近 period 本（idx を含む）の高値・安値
function highLowWindow(cs: Candle[], idx: number, period: number): { hi: number; lo: number } {
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, idx - period + 1); j <= idx; j++) {
    if (cs[j].high > hi) hi = cs[j].high;
    if (cs[j].low  < lo) lo = cs[j].low;
  }
  return { hi, lo };
}

// 一目均衡表の先行スパンA/B（過去データのみから算出、idx 時点で必要本数が揃っていなければ null）
function computeCloudPoint(cs: Candle[], idx: number): { a: number; b: number } | null {
  if (idx < SENKOU_B_PERIOD - 1) return null;
  const tenkanW  = highLowWindow(cs, idx, TENKAN_PERIOD);
  const kijunW   = highLowWindow(cs, idx, KIJUN_PERIOD);
  const senkouBW = highLowWindow(cs, idx, SENKOU_B_PERIOD);
  const tenkan = (tenkanW.hi + tenkanW.lo) / 2;
  const kijun  = (kijunW.hi + kijunW.lo) / 2;
  return { a: (tenkan + kijun) / 2, b: (senkouBW.hi + senkouBW.lo) / 2 };
}

type LineSeriesRef = ReadRef<ISeriesApi<'Line'> | null>;

export interface IndicatorSeriesRefs {
  emaSeriesRef: LineSeriesRef;
  smaSeriesRef: LineSeriesRef;
  bbBasisSeriesRef: LineSeriesRef;
  bbUpper1SeriesRef: LineSeriesRef;
  bbLower1SeriesRef: LineSeriesRef;
  bbUpper2SeriesRef: LineSeriesRef;
  bbLower2SeriesRef: LineSeriesRef;
  senkouASeriesRef: LineSeriesRef;
  senkouBSeriesRef: LineSeriesRef;
}

export interface IndicatorSeriesOptions {
  showEMA: boolean;
  showSMA: boolean;
  showBB: boolean;
  showCloud: boolean;
  overlaysHidden: boolean;
  timeframeSec: number;
  // 雲の塗りつぶし（cloudOverlay）が読む点列。非メインのeffectも書き換えるためCandleChart側が持つ
  cloudDataRef: { current: CloudPoint[] };
  syncCloudRef: ReadRef<() => void>;
}

// メインパネルのインジケータ（EMA200・SMA14・ボリンジャーバンド・雲）。表示ON/OFFのeffectを
// 登録し、リプレイ更新effectから呼ぶ「全再計算」「1本ぶんの差分更新」の関数を返す。
// 差分更新用の累積値（移動窓の合計等）はここで持つ。非メインは毎回lib/indicatorsのフル計算を使う
export function useIndicatorSeries(refs: IndicatorSeriesRefs, opts: IndicatorSeriesOptions) {
  const {
    emaSeriesRef, smaSeriesRef, bbBasisSeriesRef, bbUpper1SeriesRef, bbLower1SeriesRef,
    bbUpper2SeriesRef, bbLower2SeriesRef, senkouASeriesRef, senkouBSeriesRef,
  } = refs;
  const { showEMA, showSMA, showBB, showCloud, overlaysHidden, timeframeSec, cloudDataRef, syncCloudRef } = opts;

  // EMA 増分計算用の状態
  const emaValueRef = useRef(0);
  const emaSumRef   = useRef(0);
  const emaCountRef = useRef(0);

  // SMA14（単純移動平均・移動窓の合計を差分更新）
  const smaSumRef = useRef(0);

  // ボリンジャーバンド（移動窓の合計・二乗和で SMA・標準偏差を差分更新）
  const bbSumRef   = useRef(0);
  const bbSumSqRef = useRef(0);

  // EMA 表示 ON/OFF。overlaysHidden中はvisibleを触らず色だけ透明にする
  useEffect(() => {
    emaSeriesRef.current?.applyOptions({ visible: showEMA, color: overlaysHidden ? TRANSPARENT : EMA_COLOR });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEMA, overlaysHidden]);

  // SMA14 表示 ON/OFF（EMA同様、非表示中も裏で計算・オートスケール寄与は継続しておく）
  useEffect(() => {
    smaSeriesRef.current?.applyOptions({ visible: showSMA, color: overlaysHidden ? TRANSPARENT : SMA_COLOR });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSMA, overlaysHidden]);

  // ボリンジャーバンド 表示 ON/OFF（EMA同様、非表示中も裏で計算・オートスケール寄与は継続しておく）
  useEffect(() => {
    const t = overlaysHidden;
    bbBasisSeriesRef.current?.applyOptions({ visible: showBB, color: t ? TRANSPARENT : BB_BASIS_COLOR });
    bbUpper1SeriesRef.current?.applyOptions({ visible: showBB, color: t ? TRANSPARENT : BB_SILVER });
    bbLower1SeriesRef.current?.applyOptions({ visible: showBB, color: t ? TRANSPARENT : BB_SILVER });
    bbUpper2SeriesRef.current?.applyOptions({ visible: showBB, color: t ? TRANSPARENT : BB_SILVER });
    bbLower2SeriesRef.current?.applyOptions({ visible: showBB, color: t ? TRANSPARENT : BB_SILVER });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBB, overlaysHidden]);

  // 雲 表示 ON/OFF（同様に非表示中も裏で計算・オートスケール寄与は継続、canvas側は syncCloud 内でshowCloud/overlaysHiddenを判定）
  useEffect(() => {
    const v = showCloud;
    senkouASeriesRef.current?.applyOptions({ visible: v, color: overlaysHidden ? TRANSPARENT : CLOUD_A_COLOR });
    senkouBSeriesRef.current?.applyOptions({ visible: v, color: overlaysHidden ? TRANSPARENT : CLOUD_B_COLOR });
    syncCloudRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCloud, overlaysHidden]);

  function recomputeEmaFull(cs: Candle[], uptoIndex: number) {
    const k = 2 / (EMA_PERIOD + 1);
    let sum = 0;
    let ema = 0;
    const data: LineData[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
      const close = cs[i].close;
      if (i < EMA_PERIOD - 1) {
        sum += close;
        continue;
      }
      if (i === EMA_PERIOD - 1) {
        sum += close;
        ema = sum / EMA_PERIOD;
      } else {
        ema = close * k + ema * (1 - k);
      }
      data.push({ time: cs[i].time as Time, value: ema });
    }
    emaSeriesRef.current?.setData(data);
    emaValueRef.current = ema;
    emaSumRef.current = sum;
    emaCountRef.current = uptoIndex + 1;
  }

  function updateEmaStep(newCandle: Candle) {
    const k = 2 / (EMA_PERIOD + 1);
    const count = emaCountRef.current + 1;
    emaCountRef.current = count;

    if (count < EMA_PERIOD) {
      emaSumRef.current += newCandle.close;
      return;
    }
    if (count === EMA_PERIOD) {
      emaSumRef.current += newCandle.close;
      emaValueRef.current = emaSumRef.current / EMA_PERIOD;
    } else {
      emaValueRef.current = newCandle.close * k + emaValueRef.current * (1 - k);
    }
    emaSeriesRef.current?.update({ time: newCandle.time as Time, value: emaValueRef.current });
  }

  // SMA14: 移動窓(SMA_PERIOD)の合計を差分更新する単純移動平均
  function recomputeSMAFull(cs: Candle[], uptoIndex: number) {
    const data: LineData[] = [];
    let sum = 0;
    for (let i = 0; i <= uptoIndex; i++) {
      sum += cs[i].close;
      if (i >= SMA_PERIOD) sum -= cs[i - SMA_PERIOD].close;
      if (i >= SMA_PERIOD - 1) data.push({ time: cs[i].time as Time, value: sum / SMA_PERIOD });
    }
    smaSeriesRef.current?.setData(data);
    smaSumRef.current = sum;
  }

  function updateSMAStep(cs: Candle[], idx: number) {
    smaSumRef.current += cs[idx].close;
    if (idx >= SMA_PERIOD) smaSumRef.current -= cs[idx - SMA_PERIOD].close;
    if (idx < SMA_PERIOD - 1) return;
    smaSeriesRef.current?.update({ time: cs[idx].time as Time, value: smaSumRef.current / SMA_PERIOD });
  }

  // ボリンジャーバンド: 移動窓(BB_PERIOD)の合計・二乗和から SMA と標準偏差を算出（±1σ・±2σ）
  function recomputeBBFull(cs: Candle[], uptoIndex: number) {
    const basisData: LineData[] = [];
    const upper1Data: LineData[] = [];
    const lower1Data: LineData[] = [];
    const upper2Data: LineData[] = [];
    const lower2Data: LineData[] = [];
    let sum = 0, sumSq = 0;
    for (let i = 0; i <= uptoIndex; i++) {
      const close = cs[i].close;
      sum += close;
      sumSq += close * close;
      if (i >= BB_PERIOD) {
        const old = cs[i - BB_PERIOD].close;
        sum -= old;
        sumSq -= old * old;
      }
      if (i >= BB_PERIOD - 1) {
        const mean = sum / BB_PERIOD;
        const sd = Math.sqrt(Math.max(sumSq / BB_PERIOD - mean * mean, 0));
        const time = cs[i].time as Time;
        basisData.push({ time, value: mean });
        upper1Data.push({ time, value: mean + sd });
        lower1Data.push({ time, value: mean - sd });
        upper2Data.push({ time, value: mean + 2 * sd });
        lower2Data.push({ time, value: mean - 2 * sd });
      }
    }
    bbBasisSeriesRef.current?.setData(basisData);
    bbUpper1SeriesRef.current?.setData(upper1Data);
    bbLower1SeriesRef.current?.setData(lower1Data);
    bbUpper2SeriesRef.current?.setData(upper2Data);
    bbLower2SeriesRef.current?.setData(lower2Data);
    bbSumRef.current = sum;
    bbSumSqRef.current = sumSq;
  }

  function updateBBStep(cs: Candle[], idx: number) {
    const close = cs[idx].close;
    bbSumRef.current += close;
    bbSumSqRef.current += close * close;
    if (idx >= BB_PERIOD) {
      const old = cs[idx - BB_PERIOD].close;
      bbSumRef.current -= old;
      bbSumSqRef.current -= old * old;
    }
    if (idx < BB_PERIOD - 1) return;
    const mean = bbSumRef.current / BB_PERIOD;
    const sd = Math.sqrt(Math.max(bbSumSqRef.current / BB_PERIOD - mean * mean, 0));
    const time = cs[idx].time as Time;
    bbBasisSeriesRef.current?.update({ time, value: mean });
    bbUpper1SeriesRef.current?.update({ time, value: mean + sd });
    bbLower1SeriesRef.current?.update({ time, value: mean - sd });
    bbUpper2SeriesRef.current?.update({ time, value: mean + 2 * sd });
    bbLower2SeriesRef.current?.update({ time, value: mean - 2 * sd });
  }

  // 雲: 先行スパンA/Bを 26 本先の"足の時刻"に置いて描画（値自体は過去データのみで算出）
  function recomputeCloudFull(cs: Candle[], uptoIndex: number) {
    const aData: LineData[] = [];
    const bData: LineData[] = [];
    const points: CloudPoint[] = [];
    for (let i = 0; i <= uptoIndex; i++) {
      const pt = computeCloudPoint(cs, i);
      if (!pt) continue;
      const displaced = cloudDisplacedTime(cs, i, timeframeSec);
      aData.push({ time: displaced as Time, value: pt.a });
      bData.push({ time: displaced as Time, value: pt.b });
      points.push({ time: displaced, a: pt.a, b: pt.b });
    }
    senkouASeriesRef.current?.setData(aData);
    senkouBSeriesRef.current?.setData(bData);
    cloudDataRef.current = points;
    syncCloudRef.current();
  }

  function updateCloudStep(cs: Candle[], idx: number) {
    const pt = computeCloudPoint(cs, idx);
    if (!pt) return;
    const displaced = cloudDisplacedTime(cs, idx, timeframeSec);
    senkouASeriesRef.current?.update({ time: displaced as Time, value: pt.a });
    senkouBSeriesRef.current?.update({ time: displaced as Time, value: pt.b });
    cloudDataRef.current = [...cloudDataRef.current, { time: displaced, a: pt.a, b: pt.b }];
    syncCloudRef.current();
  }

  return {
    recomputeEmaFull, updateEmaStep, recomputeSMAFull, updateSMAStep,
    recomputeBBFull, updateBBStep, recomputeCloudFull, updateCloudStep,
  };
}
