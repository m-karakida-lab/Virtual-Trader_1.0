import type {
  DrawnArrow, DrawnBrush, DrawnChannel, DrawnLine, DrawnRect, DrawnText, DrawnTrendLine, DrawnVLine,
} from '../../types';

// CandleChartの巨大effectから切り出したモジュールへ、共有状態（ref）を渡すための型。
// 読むだけのrefはMutableRefObjectではなくこれで受ける（MutableRefObject<T>は型引数に
// 対して不変なので、例えばuseRef<TimeframeSec>をnumberとして受け取れない）
export type ReadRef<T> = { readonly current: T };

// 時刻（Unix秒）→チャート上のX座標。CandleChart側のtimeToX（実在しない時刻は前後の足で補間）
export type TimeToX = (t: number) => number | null;

// CandleChart側のgetVisibleDrawings（このパネルの時間足で非表示の図形を除いた配列）
export type GetVisibleDrawings = () => {
  lines: DrawnLine[]; vlines: DrawnVLine[]; rects: DrawnRect[];
  trendLines: DrawnTrendLine[]; channels: DrawnChannel[];
  arrows: DrawnArrow[]; brushes: DrawnBrush[]; texts: DrawnText[];
};

// ドラッグ中・新規描画中の状態はCandleChart側のマウス処理が持つletのまま。
// 描画モジュールはこのgetter経由で読むだけ（書き換えはマウス処理側だけが行う）
export type Getter<T> = () => T;
