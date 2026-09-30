import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { Getter, GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { DASH_TO_CANVAS, beginCanvasFrame, type CutCandles } from './canvas';

export interface LinesOverlayDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  overlayRef: ReadRef<HTMLDivElement | null>;
  container: HTMLDivElement;
  vlineCanvasRef: ReadRef<HTMLCanvasElement | null>;
  hlineCanvasRef: ReadRef<HTMLCanvasElement | null>;
  // 垂直線ごとの位置決め用アンカー（子に日付ラベル）
  vlineElsRef: ReadRef<Map<number, HTMLDivElement>>;
  // 選択中の水平線/垂直線の中点ハンドル（常に1個分のみ、初回syncで生成）
  lineHandleElRef: { current: HTMLDivElement | null };
  // ドラッグ中の垂直線のX座標・水平線の価格（書き換えはCandleChart側のドラッグ処理）
  getVLineDragPreview: Getter<{ id: number; x: number } | null>;
  getHLineDragPreview: Getter<{ id: number; price: number } | null>;
  timeToXSnapped: TimeToX;
  getVisibleDrawings: GetVisibleDrawings;
  cutCandlesFromCanvas: CutCandles;
}

// 垂直線の日付ラベル用。他の箇所（Controls.tsxの現在位置表示等）と同じく、Unix秒を
// ブラウザのローカルタイムゾーンに変換せずUTCゲッターで読む（足の時刻は既にJST変換済みの
// 「壁時計時刻」を秒数として持っているため、これでそのままJST表記になる）
// 年入り2桁表記（`yy`）はチャートの日付軸目盛り（tickMarkFormatter）と同じ書式に揃える
function formatVLineDate(sec: number): string {
  const d = new Date(sec * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yy} ${M}/${D} ${hh}:${mm}`;
}

// 水平線・垂直線の描画。線本体は専用canvasに自前描画し、destination-outでロウソク足と
// 重なった部分を透明に抜く（グリッド線・標準価格ラインはSeries Primitives対象外で
// 常に前面に出るため、DOMのままだとロウソク足が隠れて見づらい）。
// DOMは垂直線の日付ラベルと選択ハンドルのみ
export function createLinesOverlay(deps: LinesOverlayDeps) {
  const {
    chartRef, seriesRef, overlayRef, container, vlineCanvasRef, hlineCanvasRef,
    vlineElsRef, lineHandleElRef, getVLineDragPreview, getHLineDragPreview, timeToXSnapped, getVisibleDrawings, cutCandlesFromCanvas,
  } = deps;

  const drawVLineCanvas = () => {
    const canvas = vlineCanvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w, h } = frame;

    const { chartBottomMargin: bottomMargin, showVLineDateLabel } = useTraderStore.getState();
    const dragPreview = getVLineDragPreview();
    const lines: { x: number; color: string; dash: 'solid' | 'dashed' | 'dotted'; width: number }[] = [];
    for (const v of getVisibleDrawings().vlines) {
      const x = dragPreview && dragPreview.id === v.id ? dragPreview.x : timeToXSnapped(v.time);
      if (x === null) continue;
      lines.push({ x, color: v.color, dash: v.dash, width: v.width });
    }
    if (lines.length === 0) return;

    // 垂直系は原則日付軸欄の手前で止める。日付ラベルを出している間だけは、ラベルと一体に
    // 見えるよう軸欄の帯の中央（ラベル位置）まで伸ばす
    const bottom = h - (showVLineDateLabel ? bottomMargin / 2 : bottomMargin);
    for (const l of lines) {
      ctx.save();
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width;
      ctx.setLineDash(DASH_TO_CANVAS[l.dash]);
      ctx.beginPath();
      ctx.moveTo(l.x, 0);
      ctx.lineTo(l.x, bottom);
      ctx.stroke();
      ctx.restore();
    }

    cutCandlesFromCanvas(ctx, w);
  };

  // 価格軸のラベル（axisLabelVisible）はこのcanvasの外側（価格軸ペイン）の話なので
  // CandleChart側のcreatePriceLineは残し、lineVisible:falseで線本体のみ隠している
  const drawHLineCanvas = () => {
    const canvas = hlineCanvasRef.current;
    if (!canvas || !chartRef.current || !seriesRef.current) return;
    const frame = beginCanvasFrame(canvas);
    if (!frame) return;
    const { ctx, w } = frame;

    const { overlaysHidden: hidden } = useTraderStore.getState();
    if (hidden) return;
    const { lines: visibleLines } = getVisibleDrawings();
    const dragPreview = getHLineDragPreview();
    const segs: { y: number; color: string; dash: 'solid' | 'dashed' | 'dotted'; width: number }[] = [];
    for (const line of visibleLines) {
      const y = dragPreview && dragPreview.id === line.id
        ? seriesRef.current.priceToCoordinate(dragPreview.price)
        : seriesRef.current.priceToCoordinate(line.price);
      if (y === null) continue;
      segs.push({ y, color: line.color, dash: line.dash, width: line.width });
    }
    if (segs.length === 0) return;

    for (const s of segs) {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.setLineDash(DASH_TO_CANVAS[s.dash]);
      ctx.beginPath();
      ctx.moveTo(0, s.y);
      ctx.lineTo(w, s.y);
      ctx.stroke();
      ctx.restore();
    }

    cutCandlesFromCanvas(ctx, w);
  };

  // 垂直線の日付ラベル・選択ハンドルのDOMを更新し、水平線・垂直線のcanvasも再描画する
  const sync = () => {
    if (!chartRef.current || !overlayRef.current || !seriesRef.current) return;
    const { selected, showVLineDateLabel, chartBottomMargin: bottomMargin } = useTraderStore.getState();
    const { lines: visibleLines, vlines: visibleVLines } = getVisibleDrawings();
    const overlay = overlayRef.current;
    const existing = vlineElsRef.current;
    // 非表示中の垂直線の日付ラベルは、削除された垂直線と同じくDOMごと取り除く
    // （表示に戻れば次のsyncで作り直される）
    const nextIds = new Set(visibleVLines.map(v => v.id));
    const vlineDragPreview = getVLineDragPreview();

    for (const [id, el] of existing) {
      if (!nextIds.has(id)) { el.remove(); existing.delete(id); }
    }

    for (const v of visibleVLines) {
      let el = existing.get(v.id);
      let label: HTMLDivElement;
      if (!el) {
        // elは位置決め用の0幅アンカー（top:0, height:100%=コンテナ全体）。ラベルはこの
        // 100%基準で日付軸欄の帯の中央へ配置する
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.height = '100%';
        el.style.width = '0px';
        el.style.pointerEvents = 'none';

        // 日付軸欄（chartBottomMargin分の帯）そのものに重ねて表示する日付ラベル
        // （TradingView同様）。帯の垂直中央にあたる1点を基準にtranslateで水平・垂直とも
        // 中央寄せする
        label = document.createElement('div');
        label.style.position = 'absolute';
        label.style.left = '0';
        label.style.whiteSpace = 'nowrap';
        label.style.fontSize = '10px';
        label.style.fontWeight = '700';
        label.style.lineHeight = '1.4';
        label.style.padding = '1px 4px';
        label.style.borderRadius = '3px';
        label.style.color = '#0d0d0d';
        el.appendChild(label);
        overlay.appendChild(el);
        existing.set(v.id, el);
      } else {
        label = el.firstChild as HTMLDivElement;
      }
      const x = vlineDragPreview && vlineDragPreview.id === v.id ? vlineDragPreview.x : timeToXSnapped(v.time);
      if (x === null) {
        el.style.display = 'none';
      } else {
        el.style.display = 'block';
        el.style.left = `${x}px`;
        label.style.display = showVLineDateLabel ? 'block' : 'none';
        label.style.top = `calc(100% - ${bottomMargin / 2}px)`;
        label.style.transform = 'translate(-50%, -50%)';
        label.style.backgroundColor = v.color;
        label.textContent = formatVLineDate(v.time);
      }
    }
    drawVLineCanvas();
    drawHLineCanvas(); // 水平線も同じsync経路（onRangeChange等）に乗せて再描画する

    // 選択中の水平線・垂直線があれば中点にハンドルを1つ表示する（編集モードの目印。
    // 実際の移動は既存のドラッグ判定（findPriceTargetNear/findVLineNear）が
    // 線全体のどこでも受け付けるので、ハンドルは見た目上のマーカーを兼ねる）
    let handle = lineHandleElRef.current;
    if (!handle) {
      handle = document.createElement('div');
      handle.style.position = 'absolute';
      handle.style.width = '8px';
      handle.style.height = '8px';
      handle.style.backgroundColor = '#42a5f5';
      handle.style.border = '1px solid #fff';
      handle.style.borderRadius = '2px';
      handle.style.pointerEvents = 'none';
      handle.style.display = 'none';
      overlay.appendChild(handle);
      lineHandleElRef.current = handle;
    }
    let point: [number, number] | null = null;
    if (selected?.kind === 'h') {
      // 非表示中の水平線はvisibleLinesに含まれないので、選択中でもハンドルは出ない
      const line = visibleLines.find(l => l.id === selected.id);
      const y = line ? seriesRef.current.priceToCoordinate(line.price) : null;
      if (y !== null) point = [container.clientWidth / 2, y];
    } else if (selected?.kind === 'v') {
      const v = visibleVLines.find(vv => vv.id === selected.id);
      const x = v ? timeToXSnapped(v.time) : null;
      if (x !== null) point = [x, container.clientHeight / 2];
    }
    if (point) {
      handle.style.display = 'block';
      handle.style.left = `${point[0] - 4}px`;
      handle.style.top = `${point[1] - 4}px`;
    } else {
      handle.style.display = 'none';
    }
  };

  return { sync, drawVLineCanvas, drawHLineCanvas };
}
