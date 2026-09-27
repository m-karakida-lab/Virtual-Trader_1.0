// CandleChartの巨大effectから切り出したモジュールへ、共有状態（ref）を渡すための型。
// 読むだけのrefはMutableRefObjectではなくこれで受ける（MutableRefObject<T>は型引数に
// 対して不変なので、例えばuseRef<TimeframeSec>をnumberとして受け取れない）
export type ReadRef<T> = { readonly current: T };

// 時刻（Unix秒）→チャート上のX座標。CandleChart側のtimeToX（実在しない時刻は前後の足で補間）
export type TimeToX = (t: number) => number | null;
