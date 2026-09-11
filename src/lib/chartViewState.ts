// チャートのズーム/スケール状態を時間軸ごとに localStorage へ記憶し、次回起動時に再現する。
// 絶対時刻ではなく「右端から何本目〜何本分」という相対位置で保存するため、
// 別のCSV（日付範囲が異なるデータ）を読み込んでも同じズーム感覚が再現される。

export interface RelativeView {
  span: number;          // 表示本数の幅（to - from、フラクショナル可）
  barsFromRight: number; // 右端（最新本）からの距離（0 = 最新本が右端ぴったり）
}

const KEY_PREFIX = 'vt:chartView:';
// rightOffset相当の余裕（実本数を多少超えるのは正常な「最新足の右に空白」なので許容する）
const RIGHT_OFFSET_BUFFER_BARS = 20;

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

// 保存済みの相対ビューを、今表示しているデータの本数(totalBars)に対する絶対 logical range に変換。
// 保存済みのspan/barsFromRightは「別の（本数の多い）データセットを見ていた時」のものである
// 場合がある——例えば1Hで大量データを見てズームアウトした状態を保存した後、本数の少ない
// 別CSVを読み込むと、そのspanをそのまま使ったlogical rangeが実際のデータ本数を大きく超え、
// 実データがごく一部（あるいは可視範囲の外）に押し込められ画面がほぼ空欄に見える不具合になる
// （4画面の非メインパネルで「クリックして昇格させないとローソク足が出てこない」ように見える
// 症状の実体——昇格時は保存ビューを使わず`fitContent`相当の別経路を通るため直ってしまい、
// 「クリックしないと読み込まれない」不具合に見えていた）。実本数を基準に頭打ちする
export function relativeViewToLogicalRange(view: RelativeView, totalBars: number): { from: number; to: number } {
  const span = Math.min(view.span, totalBars + RIGHT_OFFSET_BUFFER_BARS);
  const barsFromRight = Math.min(view.barsFromRight, totalBars);
  const to = totalBars - barsFromRight;
  return { from: to - span, to };
}
