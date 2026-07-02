// 価格帯から pip 単位・表示精度を推定する。
// JPYクオート等（価格が概ね20以上）は 1pip=0.01・小数3桁、
// それ以外（EURUSD等）は 1pip=0.0001・小数5桁（フラクショナルピップ込み、TradingView と同じ表記）。
export function inferPipSize(price: number): number {
  return Math.abs(price) >= 20 ? 0.01 : 0.0001;
}

export function pricePrecision(price: number): number {
  return Math.abs(price) >= 20 ? 3 : 5;
}
