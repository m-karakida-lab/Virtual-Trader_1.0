import { useEffect } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Candle, ChartLayout, TimeframeSec } from '../../types';
import { loadChartView, relativeViewToLogicalRange } from '../../lib/chartViewState';
import { priceAtTime } from '../../lib/crosshairSync';
import { logError } from '../../lib/errorLog';
import type { ReadRef } from './refs';

const MIN_JUMP_SPAN_BARS = 30; // 日時ジャンプ時、表示幅がこの本数分未満にはならないようにする
// createChartのtimeScale.rightOffsetと同じ値（「最新足に固定」を自前計算するため）。非メインの初回フィットも使う
export const CHART_RIGHT_OFFSET_BARS = 10;

// 「最新足に固定」の追従アンカー。spanは表示本数、offsetは最新足から何本右にずらすか
export type FollowAnchor = { span: number; offset: number };

// 時刻tを含む足（t以下で最も新しい足）のインデックス
function indexAtOrBefore(cs: Candle[], t: number): number {
  let lo = 0, hi = cs.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

export interface ViewRangeRefs {
  chartRef: ReadRef<IChartApi | null>;
  displayCandlesRef: ReadRef<Candle[]>;
  // メインはcursor、非メインは表示中の末尾（実際にsetDataで描画されている最後の足）
  effectiveCursorRef: ReadRef<number>;
  isMainRef: ReadRef<boolean>;
  nonMainCandlesRef: ReadRef<Candle[]>;
  // 追従アンカーはマウント時effectのパン/ホイール処理（captureFollowAnchorFromCurrentView）と
  // メインのデータ投入effectも読み書きするため、CandleChart側が持つ
  followAnchorRef: { current: FollowAnchor | null };
  applyLatestViewRef: { current: (captureSpan: boolean) => void };
  // setVisibleLogicalRange直後は座標がレイアウト未確定のことがあるため、1フレーム後に
  // 全オーバーレイ（雲・図形・区切り線・セッション帯・売買マーカー）を描き直す
  syncAllOverlays: () => void;
}

// ── 表示範囲の操作（データ投入effectより前に宣言する側） ──────────────────────
// レイアウト切替時のリサイズ、「表示をリセット」、「最新足に固定」ボタン
export function useViewRangeCommands(
  refs: ViewRangeRefs & { handleResizeRef: ReadRef<() => void> },
  state: { chartLayout: ChartLayout; fitSignal: number; scrollToLatestSignal: number; candles: Candle[] },
) {
  const {
    chartRef, displayCandlesRef, effectiveCursorRef, isMainRef, nonMainCandlesRef,
    followAnchorRef, applyLatestViewRef, syncAllOverlays, handleResizeRef,
  } = refs;
  const { chartLayout, fitSignal, scrollToLatestSignal, candles } = state;

  // 1画面⇔4画面のレイアウト切替はパネルのCSSサイズだけを変える（ResizeObserver任せ）ため、
  // 環境によってはResizeObserverの発火が遅れる/信頼できないことがある。chartLayoutの変化を
  // 直接のトリガーとしてsetTimeout(0)経由で明示的にもhandleResizeを呼ぶ（正常な環境では
  // 二重に呼ばれるだけで、newWidth!==oldWidthのガードで2回目以降はno-opになる）
  useEffect(() => {
    const timer = setTimeout(() => handleResizeRef.current(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartLayout]);

  // 表示をリセット: TradingViewの「チャート表示をリセット」相当。時間軸のズーム（本数）を
  // デフォルトに戻し（resetTimeScale）、価格軸の手動スケール調整も解除してautoScaleへ戻す。
  // resetTimeScale単体だと最新足へスクロール位置ごと戻ってしまうため、リセット前の中心の足を
  // 控えておき、リセット後に同じ本数を保ったまま中心をその足へ戻す（スケールだけを戻す）
  useEffect(() => {
    if (fitSignal === 0 || !chartRef.current) return;
    const chart = chartRef.current;
    const ts = chart.timeScale();
    const cs = displayCandlesRef.current;
    const prevRange = ts.getVisibleLogicalRange();
    let centerTime: number | null = null;
    if (prevRange && cs.length > 0) {
      const centerIdx = Math.max(0, Math.min(cs.length - 1, Math.round((prevRange.from + prevRange.to) / 2)));
      centerTime = cs[centerIdx].time;
    }
    ts.resetTimeScale();
    chart.priceScale('right').applyOptions({ autoScale: true });
    // resetTimeScale()は内部的に更新を次の描画フレームへキューするだけで、直後に
    // getVisibleLogicalRange()を読むとリセット前の古い範囲が返る。1フレーム待ってから読み直す
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      if (centerTime !== null) {
        const newRange = ts.getVisibleLogicalRange();
        if (newRange && cs.length > 0) {
          const span = newRange.to - newRange.from;
          const idx = indexAtOrBefore(cs, centerTime);
          ts.setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
        }
      }
      raf2 = requestAnimationFrame(syncAllOverlays);
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // 最新足に固定: 縮尺は維持したまま、最新足が右オフセット分の位置に来るよう移動する。
  // 組み込みのscrollToRealTime()は既定400msのアニメーションで、その間に他のeffect（非メインの
  // setData等）が表示範囲を操作すると巻き戻されて最新足まで届かないため使わず、目標範囲を
  // 自前計算してsetVisibleLogicalRangeで即座に確定させる。
  // 表示本数（span）と右オフセットは毎回prevRangeから読み直さない——setVisibleLogicalRange直後の
  // 不安定な座標を毎tick読み直すと誤差が積み重なって縮尺が壊れる（再生を続けるとロウソク足が
  // 巨大化する）。ボタン押下時（またはアンカー未設定時）にだけ読み取ってfollowAnchorRefに固定する。
  // 手動でパン/ズームしたパネルは、その位置をcaptureFollowAnchorFromCurrentViewがアンカーに上書きする
  // （アンカーはパネルごとのrefなので、他のパネルは無関係に追従を続ける）
  applyLatestViewRef.current = (captureSpan: boolean) => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    // メインのdisplayCandles（=candles）はcursorより先の未来分も含む全期間配列なので、
    // 「最新」はcs.length-1ではなく実際に描画されている最後の足（effectiveCursorRef）
    const lastIdx = effectiveCursorRef.current;
    if (lastIdx >= 0) {
      // ボタン（「最新足に固定」）を押した瞬間は、パネルごとの手動オフセットをリセットして
      // 必ず既定の右寄せ位置に戻す（ボタンは「全パネルを標準の最新足表示に揃える」操作のため）
      if (captureSpan) followAnchorRef.current = null;
      if (followAnchorRef.current === null) {
        const prevRange = chart.timeScale().getVisibleLogicalRange();
        const rawSpan = prevRange && prevRange.to > prevRange.from
          ? prevRange.to - prevRange.from
          : MIN_JUMP_SPAN_BARS;
        followAnchorRef.current = { span: rawSpan, offset: CHART_RIGHT_OFFSET_BARS };
      }
      // 保存済みズーム幅は別データセット（本数が違う）のものを引き継いでいる場合があるため、
      // 実際の本数を大きく超える幅は頭打ちする。基準は「今revealされている本数」ではなく
      // 「CSV全期間の本数」（revealされている本数で頭打ちすると、リプレイ序盤に少数の足が
      // 画面いっぱいに間延びする「デカ足」になる）
      const fullTotal = isMainRef.current ? candles.length : nonMainCandlesRef.current.length;
      let { span: rawSpan, offset } = followAnchorRef.current;
      // 過去へ大きくスクロールした直後のアンカーはoffsetが大きな負数になり得る。fullTotal + offsetが
      // 0以下だとspanが負になりsetVisibleLogicalRangeが「from > to」で例外を投げてチャートごと
      // 落ちるため、既定の右寄せオフセットへフォールバックする
      if (fullTotal + offset <= 0) {
        offset = CHART_RIGHT_OFFSET_BARS;
        followAnchorRef.current = { span: rawSpan, offset };
      }
      const span = Math.min(rawSpan, fullTotal + offset);
      const to = lastIdx + offset;
      chart.timeScale().setVisibleLogicalRange({ from: to - span, to });
    } else {
      chart.timeScale().scrollToRealTime();
    }
  };

  useEffect(() => {
    if (scrollToLatestSignal === 0 || !chartRef.current) return;
    applyLatestViewRef.current(true);
    const raf = requestAnimationFrame(syncAllOverlays);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToLatestSignal]);
}

// ── 表示範囲の追従・同期（データ投入effectより後に宣言する側） ────────────────
// 必ずメイン/非メインのsetData effectより後ろで呼ぶこと（Reactは同一コミット内のeffectを
// 宣言順に実行する）。先に走ると、まだsetData前の空の可視範囲で追従アンカーを捕捉したり
// （そのパネルだけロウソク足が出なくなる）、seriesにまだ存在しない時刻で十字カーソルを
// 合わせて「Value is null」例外を投げたりする
export function useViewRangeSync(
  refs: ViewRangeRefs & {
    seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
    restoredViewKeyRef: { current: string | null };
    mySourceIdRef: ReadRef<string>;
    captureFollowAnchorRef: ReadRef<() => void>;
  },
  state: {
    followLatest: boolean; cursor: number; nonMainVisible: Candle[]; isMain: boolean;
    crosshairSourceId: string | null; crosshairTime: number | null; displayCandles: Candle[];
    timeframeSec: TimeframeSec; mySourceId: string; chartLayout: ChartLayout; slot: number;
    candles: Candle[]; dataVersion: number;
    centerSignal: number; centerTarget: number;
    jumpSyncSignal: number; jumpSyncSourceId: string | null; jumpSyncTarget: number;
  },
) {
  const {
    chartRef, seriesRef, displayCandlesRef, effectiveCursorRef, isMainRef, applyLatestViewRef,
    syncAllOverlays, restoredViewKeyRef, mySourceIdRef, captureFollowAnchorRef,
  } = refs;
  const {
    followLatest, cursor, nonMainVisible, isMain, crosshairSourceId, crosshairTime, displayCandles,
    timeframeSec, mySourceId, chartLayout, slot, candles, dataVersion,
    centerSignal, centerTarget, jumpSyncSignal, jumpSyncSourceId, jumpSyncTarget,
  } = state;

  // 「最新足に固定」の継続追従（followLatest）。リプレイ再生中も最新足を右寄せ位置に保つ。
  // メインはcursor、非メインはnonMainVisibleが変わるたびに実行する。非メイン（4画面の他3枠）は
  // followLatestトグルに関わらず常時追従する（しないと上位足パネルがリプレイに置いていかれる）
  useEffect(() => {
    const active = isMainRef.current ? followLatest : true;
    // followLatestがfalseになってもfollowAnchorRefはnullに戻さないこと。メインのデータ投入
    // effect（1コマ戻る・日付移動等）は直前まで固定されていたかをアンカーの非nullで判定しており、
    // ここで戻すと固定解除後の1コマ戻るで既定位置へジャンプしてしまう。再捕捉はボタン押下時だけ
    if (!active) return;
    if (!chartRef.current) return;
    applyLatestViewRef.current(false);
    const raf = requestAnimationFrame(syncAllOverlays);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLatest, cursor, nonMainVisible, isMain]);

  // 4画面時、他パネルの十字カーソルに追従表示する（自分がホバー元のときは何もしない）。
  // setCrosshairPositionはsetData直後だと価格スケールが未確定でValue is nullを投げることがある
  // ため1フレーム後に呼び、失敗しても画面全体を落とさないようtry/catchでerrorLogに記録する。
  // サイズ0の非表示パネル（1画面時の非メイン3枠、3画面時の使わない枠3）は必ず失敗し、
  // 同期する意味も無いので呼ばない
  useEffect(() => {
    const isHiddenPane = chartLayout === '1' || (chartLayout === '3' && slot === 3);
    if (isHiddenPane && !isMain) return;
    if (!chartRef.current || !seriesRef.current || crosshairSourceId === mySourceId) return;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (crosshairTime === null) {
      const raf = requestAnimationFrame(() => {
        try { chart.clearCrosshairPosition(); } catch (e) { logError('CandleChart:crosshairSync', e); }
      });
      return () => cancelAnimationFrame(raf);
    }
    // メインのdisplayCandles(=candles)は未来分も含む全期間配列なので、実際に描画されている
    // 範囲（effectiveCursorRef）にクリップしてから探す（未来足にヒットするとValue is null）
    const visibleForCrosshair = isMain
      ? displayCandles.slice(0, effectiveCursorRef.current + 1)
      : displayCandles;
    const hit = priceAtTime(visibleForCrosshair, crosshairTime, timeframeSec);
    const raf = requestAnimationFrame(() => {
      try {
        if (hit === null) { chart.clearCrosshairPosition(); return; }
        chart.setCrosshairPosition(hit.price, hit.time as Time, series);
      } catch (e) {
        logError('CandleChart:crosshairSync', e);
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crosshairSourceId, crosshairTime, displayCandles, timeframeSec, mySourceId, isMain, cursor, chartLayout, slot]);

  // 時間軸の切替・新規CSV読み込み時の表示位置決定。切替先の時間足自身の前回のズーム
  // （`vt:chartView:<timeframeSec>`）を復元した上で、最新足に固定する（位置は常に最新足、
  // 縮尺だけ引き継ぐ）。spanのクランプ基準はCSV全期間の本数（cursor+1で頭打ちすると
  // 読み込み直後に1本が全幅に間延びする）
  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return;
    const key = `${timeframeSec}:${dataVersion}`;
    if (restoredViewKeyRef.current === key) return;
    restoredViewKeyRef.current = key;

    const saved = loadChartView(timeframeSec);
    if (saved && candles.length > 0) {
      const { from, to } = relativeViewToLogicalRange(saved, candles.length);
      const span = to - from;
      // revealされている本数がspanより少ない序盤は、fromが負（実データの無い過去側）に
      // はみ出し、架空の時刻が外挿されて軸の日付がずれるため、toは固定したままfromを0で止める
      const rangeTo = cursor + CHART_RIGHT_OFFSET_BARS;
      chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, rangeTo - span), to: rangeTo });
    } else {
      chartRef.current.timeScale().scrollToRealTime();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframeSec, dataVersion, candles, cursor]);

  // 指定時刻を中心に表示（縮尺=現在の表示本数は維持したまま移動）。足のインデックス（logical
  // range）ベースで計算し、最小表示本数を下回らないようにする。インデックスはグローバルな
  // candlesではなく、このパネル自身が表示しているdisplayCandlesRefで求めること
  // （非メインは別の時間軸の別配列なので、メインの配列のインデックスでは全く違う位置に飛ぶ）
  useEffect(() => {
    const cs = displayCandlesRef.current;
    if (centerSignal === 0 || !chartRef.current || cs.length === 0) return;
    const chart = chartRef.current;
    const targetIdx = indexAtOrBefore(cs, centerTarget);
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const currentSpan = logicalRange ? logicalRange.to - logicalRange.from : 0;
    const span = Math.max(currentSpan, MIN_JUMP_SPAN_BARS);
    const half = span / 2;
    chart.timeScale().setVisibleLogicalRange({ from: targetIdx - half, to: targetIdx + half });
    const raf = requestAnimationFrame(syncAllOverlays);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerSignal]);

  // 他時間足へのジャンプ同期: クリックが発生したパネル自身は動かさず、他の枠だけ
  // 「クリックされた足の時刻」を中心に移動する（インデックスは上と同じく自パネルの配列で求める）
  useEffect(() => {
    if (jumpSyncSignal === 0 || !chartRef.current) return;
    if (jumpSyncSourceId === mySourceIdRef.current) return;
    const chart = chartRef.current;
    const cs = displayCandlesRef.current;
    if (cs.length === 0) return;
    const targetIdx = indexAtOrBefore(cs, jumpSyncTarget);
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const currentSpan = logicalRange ? logicalRange.to - logicalRange.from : 0;
    const span = Math.max(currentSpan, MIN_JUMP_SPAN_BARS);
    const half = span / 2;
    chart.timeScale().setVisibleLogicalRange({ from: targetIdx - half, to: targetIdx + half });
    const raf = requestAnimationFrame(() => {
      // 非メインは常時追従がデフォルトなので、ジャンプ直後の位置を新しい追従アンカーとして
      // 採用する（古いアンカーのままだと、メイン昇格等でnonMainVisibleが変わった瞬間に
      // 追従effectが再発火してジャンプ後の位置を最新足へ戻してしまう）
      captureFollowAnchorRef.current();
      syncAllOverlays();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSyncSignal]);
}
