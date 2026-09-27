import type { IChartApi, Time } from 'lightweight-charts';
import type { Candle } from '../../types';
import { useTraderStore } from '../../store/useTraderStore';
import type { ReadRef } from './refs';

// 週/月/年区切り線のラベル用（時刻は含めない、日付のみ）
function formatSeparatorDate(sec: number): string {
  const d = new Date(sec * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  return `${yy} ${M}/${D}`;
}

export interface WeekLinesOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  // 区切り線の時刻（computeSeparatorBoundariesの結果）。CandleChart側のeffectが足の更新時に差し替える
  boundariesRef: ReadRef<number[]>;
  // 区切り線ごとのDOM要素（0幅アンカー＞線本体＋ラベル）。十字カーソル接近時のラベル隠しでも参照される
  elsRef: ReadRef<HTMLDivElement[]>;
  // 現在足の判定用（メインのdisplayCandlesは未来分も含む全期間なので、cursorより先の区切りは隠す）
  displayCandlesRef: ReadRef<Candle[]>;
  effectiveCursorRef: ReadRef<number>;
}

// ── 週区切り線の位置を再計算して DOM に反映（控えめな破線、固定スタイル） ──
// Series Primitivesで描く方式を試したが、グリッド線がPrimitivesの対象外で常に
// その上に描画されるため、グリッド線との交差点で区切り線が削れて見える・グリッドと
// 同化して見づらくなる不具合になった。四角形と同じ理由でDOMオーバーレイに戻す
// （区切り線はローソク足の下である必要はなく、そもそも常時前面表示で問題なかった機能。
// 四角形のcanvas（zIndex:9）より下＝zIndex:8にして「四角形が区切り線より上」だけ維持する）
export function createSyncWeekLines({ chartRef, overlayRef, boundariesRef, elsRef, displayCandlesRef, effectiveCursorRef }: WeekLinesOverlayDeps): () => void {
  return () => {
    if (!chartRef.current || !overlayRef.current) return;
    const { showWeekLines: show, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const overlay = overlayRef.current;
    overlay.style.display = show ? 'block' : 'none';
    if (!show) return;

    const boundaries = boundariesRef.current;
    const els = elsRef.current;

    // lightweight-charts自身の目盛り（tickMarkFormatter）は間隔優先の自動配置のため、
    // 区切り線の位置と必ずしも一致しない（区切り線はあるのに真上の目盛りは別の日、という
    // ズレが起きる）。区切り線の位置には必ず日付が出るよう、線ごとに専用の日付ラベルを
    // 自前で表示する（垂直線の日付ラベルと同じDOMパターン: elが位置決め用の0幅アンカー、
    // 中のlineEl/labelがそれぞれ線本体とラベル）
    while (els.length < boundaries.length) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.top = '0';
      el.style.height = '100%';
      el.style.width = '0px';
      el.style.pointerEvents = 'none';

      const lineEl = document.createElement('div');
      lineEl.style.position = 'absolute';
      lineEl.style.top = '0';
      lineEl.style.width = '0px';
      lineEl.style.borderLeft = '1px dashed #4a4a4a';
      el.appendChild(lineEl);

      const label = document.createElement('div');
      label.style.position = 'absolute';
      label.style.left = '0';
      label.style.whiteSpace = 'nowrap';
      label.style.fontSize = '10px';
      label.style.fontWeight = '700';
      label.style.lineHeight = '1.4';
      label.style.padding = '1px 4px';
      label.style.borderRadius = '3px';
      label.style.color = '#e0e0e0';
      label.style.backgroundColor = '#4a4a4a';
      label.style.border = '1px solid #666';
      el.appendChild(label);

      overlay.appendChild(el);
      els.push(el);
    }
    while (els.length > boundaries.length) {
      els.pop()?.remove();
    }

    const timeScale = chartRef.current.timeScale();
    // まだ表示していない未来の区切りは線ごと出さない（雲が時間軸を未来側へ延ばしているため、
    // 未来の時刻にもtimeToCoordinateが座標を返してしまう）
    const currentTime = displayCandlesRef.current[effectiveCursorRef.current]?.time ?? Infinity;
    const xs = boundaries.map(t => (t <= currentTime ? timeScale.timeToCoordinate(t as Time) : null));
    const isSaturday = (t: number) => new Date(t * 1000).getUTCDay() === 6;
    // ラベルは画面内で最も新しい区切り線1本だけに出す（線自体は全区切り線ぶん描く）。
    // timeToCoordinateは画面外の時刻にも座標を返すため、表示幅の範囲内に絞ること。
    // 土曜日は月曜の区切りと近接してラベル同士がぶつかるため、1本前の平日の区切り線に譲る。
    // ただし画面内の区切り線が土曜日だけの時は、ぶつかる相手がいないので土曜日に出す
    const paneWidth = timeScale.width();
    let latestIdx = -1;
    let latestSaturdayIdx = -1;
    for (let i = xs.length - 1; i >= 0; i--) {
      const x = xs[i];
      if (x === null || x < 0 || x > paneWidth) continue;
      if (!isSaturday(boundaries[i])) { latestIdx = i; break; }
      if (latestSaturdayIdx < 0) latestSaturdayIdx = i;
    }
    if (latestIdx < 0) latestIdx = latestSaturdayIdx;
    boundaries.forEach((t, i) => {
      const x = xs[i];
      const el = els[i];
      const lineEl = el.firstChild as HTMLDivElement;
      const label = el.lastChild as HTMLDivElement;
      if (x === null) {
        el.style.display = 'none';
      } else {
        el.style.display = 'block';
        el.style.left = `${x}px`;
        // ラベルを出さない土曜日の区切り線は軸欄手前ギリギリで止める（平日の区切り線は
        // ラベルの有無に関わらず軸欄の帯の中央＝ラベル位置まで伸ばす）
        const labeled = i === latestIdx;
        lineEl.style.height = `calc(100% - ${isSaturday(t) && !labeled ? bottomMargin : bottomMargin / 2}px)`;
        if (!labeled) {
          label.style.display = 'none';
        } else {
          label.style.display = 'block';
          label.style.top = `calc(100% - ${bottomMargin / 2}px)`;
          label.style.transform = 'translate(-50%, -50%)';
          label.textContent = formatSeparatorDate(t);
        }
      }
    });
  };
}
