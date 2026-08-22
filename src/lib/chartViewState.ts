// チャートのズーム/スケール状態を時間軸ごとに localStorage へ記憶し、次回起動時に再現する。
// 絶対時刻ではなく「右端から何本目〜何本分」という相対位置で保存するため、
// 別のCSV（日付範囲が異なるデータ）を読み込んでも同じズーム感覚が再現される。

export interface RelativeView {
  span: number;          // 表示本数の幅（to - from、フラクショナル可）
  barsFromRight: number; // 右端（最新本）からの距離（0 = 最新本が右端ぴったり）
}

const KEY_PREFIX = 'vt:chartView:';

export function loadChartView(timeframeSec: number): RelativeView | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + timeframeSec);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v.span === 'number' && typeof v.barsFromRight === 'number' && v.span > 0) return v;
    return null;
  } catch {
    return null;
  }
}

export function saveChartView(timeframeSec: number, view: RelativeView): void {
  try {
    localStorage.setItem(KEY_PREFIX + timeframeSec, JSON.stringify(view));
  } catch {
    // localStorage が使えない/容量超過等は無視（表示状態の記憶は失敗しても致命的ではない）
  }
}

// 保存済みの相対ビューを、今表示しているデータの本数(totalBars)に対する絶対 logical range に変換
export function relativeViewToLogicalRange(view: RelativeView, totalBars: number): { from: number; to: number } {
  const to = totalBars - view.barsFromRight;
  return { from: to - view.span, to };
}
