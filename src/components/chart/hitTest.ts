import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useTraderStore } from '../../store/useTraderStore';
import type { GetVisibleDrawings, ReadRef, TimeToX } from './refs';
import { distanceToSegment } from './coordinates';

const DRAG_TOLERANCE_PX = 6;
// 四角形の角・辺ハンドル等は見た目が小さく掴みにくいため、ヒット判定だけ
// DRAG_TOLERANCE_PXより広く取る（水平線・垂直線・TP/SL等の他のドラッグ対象は対象外）
const RECT_HANDLE_HIT_PX = 12;

// 水平方向にドラッグ可能な対象（水平線 / 未約定注文 / TP / SL）
export type DragTarget =
  | { kind: 'hline'; id: number }
  | { kind: 'order'; id: number }
  | { kind: 'tp'; id: number }
  | { kind: 'sl'; id: number }
  | { kind: 'orderTp'; id: number }
  | { kind: 'orderSl'; id: number };

// 四角形のドラッグ中の角。timeField/priceFieldは「動かす方の角が持つフィールド名」
// （反対側の角は固定したまま、この2フィールドだけ更新してリサイズする）
export interface RectCorner {
  rectId: number;
  timeField: 'time1' | 'time2';
  priceField: 'price1' | 'price2';
}

// 四角形のドラッグ中の辺（4隅の中間点）。1フィールドだけ更新して上下/左右いずれか一方向にリサイズする
export interface RectEdge {
  rectId: number;
  field: 'time1' | 'time2' | 'price1' | 'price2';
}

// トレンドラインのドラッグ中の端点。四角形の角と同じ考え方（反対側の端点は固定したまま
// この2フィールドだけ更新する）だが、トレンドラインは端点が2つだけで辺の概念が無い
export interface TrendEndpoint {
  trendId: number;
  timeField: 'time1' | 'time2';
  priceField: 'price1' | 'price2';
}

// 平行チャネルの基準線のドラッグ中の端点。トレンドラインと同じ構造（offsetは端点操作では変わらない）
export interface ChannelEndpoint {
  channelId: number;
  timeField: 'time1' | 'time2';
  priceField: 'price1' | 'price2';
}

// 矢印のドラッグ中の端点。トレンドラインと全く同じ構造（2端点、辺の概念なし）
export interface ArrowEndpoint {
  arrowId: number;
  timeField: 'time1' | 'time2';
  priceField: 'price1' | 'price2';
}

// 図形認識で作った三角形ブラシのドラッグ中の頂点（points配列内のインデックス0〜2。
// 3番目=points[3]はループを閉じるための始点の複製なので、頂点としては編集対象にしない）
export interface BrushVertex {
  brushId: number;
  vertexIndex: 0 | 1 | 2;
}

// 図形認識で作った円ブラシのドラッグ中のバウンディングボックス角。掴んで拡縮すると
// 点列（楕円の外周）を新しいボックスに合わせて再生成する
export interface BrushCircleCorner {
  brushId: number;
  corner: 'tl' | 'tr' | 'bl' | 'br';
}

type SegmentPx = { x1: number; y1: number; x2: number; y2: number };
type EndpointFields = { timeField: 'time1' | 'time2'; priceField: 'price1' | 'price2' };

export interface HitTestDeps {
  chartRef: ReadRef<IChartApi | null>;
  seriesRef: ReadRef<ISeriesApi<'Candlestick'> | null>;
  // テキストは実体のDOM要素の実測サイズで判定する
  textElsRef: ReadRef<Map<number, HTMLDivElement>>;
  getVisibleDrawings: GetVisibleDrawings;
  timeToX: TimeToX;
  // 垂直線は表示と同じくスナップ版で判定する（timeToXのままだと他時間足パネルで見た目とズレる）
  timeToXSnapped: TimeToX;
}

// 描画物・価格ラインの当たり判定。どれも状態を持たず、その時点のstoreと座標変換だけで判定する。
// どの判定を先に試すか（優先順位）は呼び出し側（CandleChartのmousedown・ホバー）が決める
export function createHitTests(deps: HitTestDeps) {
  const { chartRef, seriesRef, textElsRef, getVisibleDrawings, timeToX, timeToXSnapped } = deps;

  // 発注パネルの draft 価格（price/TP/SL）のプレビュー線をドラッグで調整
  const findDraftNear = (y: number): 'price' | 'tp' | 'sl' | null => {
    if (!seriesRef.current) return null;
    const { orderType: ot, draftPrice: dp, draftTP: dtp, draftSL: dsl } = useTraderStore.getState();
    if (ot !== 'market' && dp !== null) {
      const ly = seriesRef.current.priceToCoordinate(dp);
      if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'price';
    }
    if (dtp !== null) {
      const ly = seriesRef.current.priceToCoordinate(dtp);
      if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'tp';
    }
    if (dsl !== null) {
      const ly = seriesRef.current.priceToCoordinate(dsl);
      if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return 'sl';
    }
    return null;
  };

  // 水平線のみの近傍判定。四角形とy座標が重なる場合、水平線はx座標を問わず画面全幅で
  // ヒットしてしまい四角形の枠・本体を覆い隠すため、mousedownでは四角形の判定より後に呼ぶ
  // （四角形の編集を優先する）
  const findHLineNear = (y: number): number | null => {
    if (!seriesRef.current) return null;
    for (const line of getVisibleDrawings().lines) {
      const ly = seriesRef.current.priceToCoordinate(line.price);
      if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return line.id;
    }
    return null;
  };

  const findPriceTargetNear = (y: number): DragTarget | null => {
    if (!seriesRef.current) return null;
    const { pendingOrders: currentOrders, positions: currentPositions } = useTraderStore.getState();
    for (const order of currentOrders) {
      const ly = seriesRef.current.priceToCoordinate(order.price);
      if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'order', id: order.id };
      if (order.tp !== undefined) {
        const tly = seriesRef.current.priceToCoordinate(order.tp);
        if (tly !== null && Math.abs(tly - y) <= DRAG_TOLERANCE_PX) return { kind: 'orderTp', id: order.id };
      }
      if (order.sl !== undefined) {
        const sly = seriesRef.current.priceToCoordinate(order.sl);
        if (sly !== null && Math.abs(sly - y) <= DRAG_TOLERANCE_PX) return { kind: 'orderSl', id: order.id };
      }
    }
    for (const pos of currentPositions) {
      if (pos.tp !== undefined) {
        const ly = seriesRef.current.priceToCoordinate(pos.tp);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'tp', id: pos.id };
      }
      if (pos.sl !== undefined) {
        const ly = seriesRef.current.priceToCoordinate(pos.sl);
        if (ly !== null && Math.abs(ly - y) <= DRAG_TOLERANCE_PX) return { kind: 'sl', id: pos.id };
      }
    }
    return null;
  };

  const findVLineNear = (x: number): number | null => {
    if (!chartRef.current) return null;
    for (const v of getVisibleDrawings().vlines) {
      // 表示位置（timeToXSnapped）と当たり判定は一致させること。timeToXのままだと
      // 他時間足のパネルでは見た目の線の位置とクリック判定がズレてしまう
      const vx = timeToXSnapped(v.time);
      if (vx !== null && Math.abs(vx - x) <= DRAG_TOLERANCE_PX) return v.id;
    }
    return null;
  };

  // 四角形の4つの角のいずれかの近くか判定（リサイズハンドル）
  const findRectCornerNear = (x: number, y: number): RectCorner | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    const { selected } = useTraderStore.getState();
    // ハンドル（角の小さな四角）は選択中の四角形にしか表示されないため、判定も選択中のものだけに
    // 限定する。そうしないと未選択の四角形の辺のちょうど中央あたりを「枠を掴んで移動」しようとした
    // 際に、見えないハンドルに引っかかって意図せずリサイズされてしまう
    for (const r of getVisibleDrawings().rects.filter(rr => selected?.kind === 'rect' && selected.id === rr.id)) {
      const x1 = timeToX(r.time1);
      const x2 = timeToX(r.time2);
      const y1 = seriesRef.current.priceToCoordinate(r.price1);
      const y2 = seriesRef.current.priceToCoordinate(r.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const corners: [number, number, RectCorner['timeField'], RectCorner['priceField']][] = [
        [x1, y1, 'time1', 'price1'],
        [x1, y2, 'time1', 'price2'],
        [x2, y1, 'time2', 'price1'],
        [x2, y2, 'time2', 'price2'],
      ];
      for (const [cx, cy, timeField, priceField] of corners) {
        if (Math.hypot(cx - x, cy - y) <= RECT_HANDLE_HIT_PX) {
          return { rectId: r.id, timeField, priceField };
        }
      }
    }
    return null;
  };

  // 四角形の4辺の中点のいずれかの近くか判定（上下または左右いずれか一方向だけのリサイズ）。
  // 「上辺」「左辺」等は画面上の位置（min/max）で決めるが、実際に更新するフィールドは
  // time1/time2・price1/price2 のうち掴んだ瞬間にその位置にあった方1つに固定する
  // （四角形の中身をドラッグで反転させても、その後は同じフィールドを更新し続ける。角のドラッグと同じ考え方）
  const findRectEdgeNear = (x: number, y: number): RectEdge | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    const { selected } = useTraderStore.getState();
    // 角のハンドルと同じ理由で、選択中の四角形の辺だけを対象にする
    for (const r of getVisibleDrawings().rects.filter(rr => selected?.kind === 'rect' && selected.id === rr.id)) {
      const x1 = timeToX(r.time1);
      const x2 = timeToX(r.time2);
      const y1 = seriesRef.current.priceToCoordinate(r.price1);
      const y2 = seriesRef.current.priceToCoordinate(r.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
      const topField: RectEdge['field'] = y1 <= y2 ? 'price1' : 'price2';
      const bottomField: RectEdge['field'] = y1 <= y2 ? 'price2' : 'price1';
      const leftField: RectEdge['field'] = x1 <= x2 ? 'time1' : 'time2';
      const rightField: RectEdge['field'] = x1 <= x2 ? 'time2' : 'time1';
      const edges: [number, number, RectEdge['field']][] = [
        [midX, Math.min(y1, y2), topField],
        [midX, Math.max(y1, y2), bottomField],
        [Math.min(x1, x2), midY, leftField],
        [Math.max(x1, x2), midY, rightField],
      ];
      for (const [ex, ey, field] of edges) {
        if (Math.hypot(ex - x, ey - y) <= RECT_HANDLE_HIT_PX) {
          return { rectId: r.id, field };
        }
      }
    }
    return null;
  };

  // 四角形の枠線上（角・辺の中点ハンドルは含まない、辺全体）を掴んだかどうかの判定。
  // mousedownではfindRectCornerNear/findRectEdgeNearの後に呼ぶことで、ハンドル上の
  // クリックは常にリサイズが優先され、それ以外の枠線上のクリックだけが平行移動になる
  const findRectBorderNear = (x: number, y: number): number | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    for (const r of getVisibleDrawings().rects) {
      const x1 = timeToX(r.time1);
      const x2 = timeToX(r.time2);
      const y1 = seriesRef.current.priceToCoordinate(r.price1);
      const y2 = seriesRef.current.priceToCoordinate(r.price2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const left = Math.min(x1, x2), right = Math.max(x1, x2);
      const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
      const withinX = x >= left - DRAG_TOLERANCE_PX && x <= right + DRAG_TOLERANCE_PX;
      const withinY = y >= top - DRAG_TOLERANCE_PX && y <= bottom + DRAG_TOLERANCE_PX;
      const nearVerticalEdge   = withinY && (Math.abs(x - left) <= DRAG_TOLERANCE_PX || Math.abs(x - right) <= DRAG_TOLERANCE_PX);
      const nearHorizontalEdge = withinX && (Math.abs(y - top) <= DRAG_TOLERANCE_PX || Math.abs(y - bottom) <= DRAG_TOLERANCE_PX);
      if (nearVerticalEdge || nearHorizontalEdge) return r.id;
    }
    return null;
  };

  // ── 2点図形（トレンドライン・平行チャネル・矢印）の当たり判定の共通部品 ──
  // どれも(time1,price1)-(time2,price2)の線分なので、ピクセル変換・端点判定・本体判定を
  // ここに集約し、各findXxxNearは「どの図形の、どの2点を判定するか」だけを書く

  // 両端をピクセル座標に変換する。どちらかが変換できない（表示範囲外等）ならnull
  const projectSegment = (time1: number, price1: number, time2: number, price2: number): SegmentPx | null => {
    if (!seriesRef.current) return null;
    const x1 = timeToX(time1), x2 = timeToX(time2);
    const y1 = seriesRef.current.priceToCoordinate(price1), y2 = seriesRef.current.priceToCoordinate(price2);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
    return { x1, y1, x2, y2 };
  };

  // 端点ハンドル（RECT_HANDLE_HIT_PX以内）のどちらに当たったか。始点を先に判定する
  const hitSegmentEndpoint = (seg: SegmentPx, x: number, y: number): EndpointFields | null => {
    if (Math.hypot(seg.x1 - x, seg.y1 - y) <= RECT_HANDLE_HIT_PX) return { timeField: 'time1', priceField: 'price1' };
    if (Math.hypot(seg.x2 - x, seg.y2 - y) <= RECT_HANDLE_HIT_PX) return { timeField: 'time2', priceField: 'price2' };
    return null;
  };

  // 線分本体（DRAG_TOLERANCE_PX以内）に当たったか
  const hitSegmentBody = (seg: SegmentPx, x: number, y: number): boolean =>
    distanceToSegment(x, y, seg.x1, seg.y1, seg.x2, seg.y2) <= DRAG_TOLERANCE_PX;

  // トレンドラインの端点近傍判定（リサイズハンドル）。四角形の角ハンドルと同じ理由で、
  // 選択中のトレンドラインにしか効かない（見た目のハンドルも選択中にしか出さないため）
  const findTrendEndpointNear = (x: number, y: number): TrendEndpoint | null => {
    const { selected } = useTraderStore.getState();
    if (selected?.kind !== 'trend') return null;
    const tl = getVisibleDrawings().trendLines.find(t => t.id === selected.id);
    if (!tl) return null;
    const seg = projectSegment(tl.time1, tl.price1, tl.time2, tl.price2);
    const hit = seg && hitSegmentEndpoint(seg, x, y);
    return hit ? { trendId: tl.id, ...hit } : null;
  };

  // トレンドライン本体（線分）の近傍判定。ヒットしたら選択、掴んだままドラッグすると平行移動
  const findTrendLineNear = (x: number, y: number): number | null => {
    for (const tl of getVisibleDrawings().trendLines) {
      const seg = projectSegment(tl.time1, tl.price1, tl.time2, tl.price2);
      if (seg && hitSegmentBody(seg, x, y)) return tl.id;
    }
    return null;
  };

  // 平行チャネルの基準線の端点近傍判定（選択中のみ、トレンドラインと同じ）
  const findChannelEndpointNear = (x: number, y: number): ChannelEndpoint | null => {
    const { selected } = useTraderStore.getState();
    if (selected?.kind !== 'channel') return null;
    const ch = getVisibleDrawings().channels.find(c => c.id === selected.id);
    if (!ch) return null;
    const seg = projectSegment(ch.time1, ch.price1, ch.time2, ch.price2);
    const hit = seg && hitSegmentEndpoint(seg, x, y);
    return hit ? { channelId: ch.id, ...hit } : null;
  };

  // 平行チャネルの基準線本体の近傍判定。ヒットしたら選択、掴んだままドラッグすると平行移動
  const findChannelBaseNear = (x: number, y: number): number | null => {
    for (const ch of getVisibleDrawings().channels) {
      const seg = projectSegment(ch.time1, ch.price1, ch.time2, ch.price2);
      if (seg && hitSegmentBody(seg, x, y)) return ch.id;
    }
    return null;
  };

  // 平行チャネルの2本目（オフセット線）本体の近傍判定。掴んだままドラッグするとオフセット（幅）調整
  const findChannelOffsetLineNear = (x: number, y: number): number | null => {
    for (const ch of getVisibleDrawings().channels) {
      const seg = projectSegment(ch.time1, ch.price1 + ch.offset, ch.time2, ch.price2 + ch.offset);
      if (seg && hitSegmentBody(seg, x, y)) return ch.id;
    }
    return null;
  };

  // 矢印の端点近傍判定（トレンドラインと同じ、選択中の矢印のみ対象）
  const findArrowEndpointNear = (x: number, y: number): ArrowEndpoint | null => {
    const { selected } = useTraderStore.getState();
    if (selected?.kind !== 'arrow') return null;
    const ar = getVisibleDrawings().arrows.find(a => a.id === selected.id);
    if (!ar) return null;
    const seg = projectSegment(ar.time1, ar.price1, ar.time2, ar.price2);
    const hit = seg && hitSegmentEndpoint(seg, x, y);
    return hit ? { arrowId: ar.id, ...hit } : null;
  };

  // 矢印本体（線分）の近傍判定。ヒットしたら選択、掴んだままドラッグすると平行移動
  const findArrowNear = (x: number, y: number): number | null => {
    for (const ar of getVisibleDrawings().arrows) {
      const seg = projectSegment(ar.time1, ar.price1, ar.time2, ar.price2);
      if (seg && hitSegmentBody(seg, x, y)) return ar.id;
    }
    return null;
  };

  // 図形認識で作った三角形ブラシの頂点近傍判定（選択中の三角形のみ対象、トレンドラインの
  // 端点判定と同じ考え方）
  const findBrushVertexNear = (x: number, y: number): BrushVertex | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    const { selected } = useTraderStore.getState();
    for (const b of getVisibleDrawings().brushes.filter(bb => bb.shape === 'triangle' && selected?.kind === 'brush' && selected.id === bb.id)) {
      for (let i = 0; i < 3; i++) {
        const px = timeToX(b.points[i].time);
        const py = seriesRef.current.priceToCoordinate(b.points[i].price);
        if (px === null || py === null) continue;
        if (Math.hypot(px - x, py - y) <= RECT_HANDLE_HIT_PX) return { brushId: b.id, vertexIndex: i as 0 | 1 | 2 };
      }
    }
    return null;
  };

  // 図形認識で作った円ブラシのバウンディングボックス角の近傍判定（選択中の円のみ対象）
  const findBrushCircleCornerNear = (x: number, y: number): BrushCircleCorner | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    const { selected } = useTraderStore.getState();
    for (const b of getVisibleDrawings().brushes.filter(bb => bb.shape === 'circle' && selected?.kind === 'brush' && selected.id === bb.id)) {
      const pxPts: { x: number; y: number }[] = [];
      for (const p of b.points) {
        const px = timeToX(p.time), py = seriesRef.current.priceToCoordinate(p.price);
        if (px !== null && py !== null) pxPts.push({ x: px, y: py });
      }
      if (pxPts.length === 0) continue;
      const minX = Math.min(...pxPts.map(p => p.x)), maxX = Math.max(...pxPts.map(p => p.x));
      const minY = Math.min(...pxPts.map(p => p.y)), maxY = Math.max(...pxPts.map(p => p.y));
      const corners: { corner: BrushCircleCorner['corner']; x: number; y: number }[] = [
        { corner: 'tl', x: minX, y: minY }, { corner: 'tr', x: maxX, y: minY },
        { corner: 'bl', x: minX, y: maxY }, { corner: 'br', x: maxX, y: maxY },
      ];
      for (const c of corners) {
        if (Math.hypot(c.x - x, c.y - y) <= RECT_HANDLE_HIT_PX) return { brushId: b.id, corner: c.corner };
      }
    }
    return null;
  };

  // ブラシ（フリーハンド）の近傍判定。点列を線分の連なりとみなし、隣接する各線分との
  // 最短距離がしきい値以内ならヒットとする（トレンドラインと同じdistanceToSegmentを使う）
  const findBrushNear = (x: number, y: number): number | null => {
    if (!chartRef.current || !seriesRef.current) return null;
    for (const b of getVisibleDrawings().brushes) {
      const pts = b.points.map(p => ({ x: timeToX(p.time), y: seriesRef.current!.priceToCoordinate(p.price) }));
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i], p1 = pts[i + 1];
        if (p0.x === null || p0.y === null || p1.x === null || p1.y === null) continue;
        if (distanceToSegment(x, y, p0.x, p0.y, p1.x, p1.y) <= DRAG_TOLERANCE_PX) return b.id;
      }
    }
    return null;
  };

  // テキストボックスの近傍判定。実体はDOM要素なので、time/priceから座標を再計算せず
  // 直接そのDOM要素の実測位置・サイズ（offsetLeft/Top/Width/Height）を使う
  // （文字数でサイズが変わるため、rectのような座標計算では判定できない）
  const findTextNear = (x: number, y: number): number | null => {
    for (const t of getVisibleDrawings().texts) {
      const el = textElsRef.current.get(t.id);
      if (!el || el.style.display === 'none') continue;
      const left = el.offsetLeft - DRAG_TOLERANCE_PX;
      const top = el.offsetTop - DRAG_TOLERANCE_PX;
      const right = el.offsetLeft + el.offsetWidth + DRAG_TOLERANCE_PX;
      const bottom = el.offsetTop + el.offsetHeight + DRAG_TOLERANCE_PX;
      if (x >= left && x <= right && y >= top && y <= bottom) return t.id;
    }
    return null;
  };

  return {
    findDraftNear, findHLineNear, findPriceTargetNear, findVLineNear,
    findRectCornerNear, findRectEdgeNear, findRectBorderNear,
    findTrendEndpointNear, findTrendLineNear,
    findChannelEndpointNear, findChannelBaseNear, findChannelOffsetLineNear,
    findArrowEndpointNear, findArrowNear,
    findBrushVertexNear, findBrushCircleCornerNear, findBrushNear, findTextNear,
  };
}
