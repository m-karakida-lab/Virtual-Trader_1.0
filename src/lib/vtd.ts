// チャートへの書き込み（水平線・垂直線・四角形）を、読み込んだCSV本体と1つのファイルに
// まとめて保存・復元するための最小限のバンドル形式。
//
// 仕組みは単純: CSVの行データをそのまま残し、末尾にこのファイル専用の区切り文字列を1行
// 追加し、その後ろに描画データのJSONを1つ書くだけ。区切り文字列より前はDuckDBにとって
// 普通のCSVそのものなので、read_csv側の実装には一切手を入れていない。
// マーカーが無いファイル（証券会社の生CSV）は今まで通りそのまま読み込める。
import type { DrawnLine, DrawnVLine, DrawnRect, DrawnTrendLine, DrawnText } from '../types';

const VTD_MARKER = '\n===VT_DRAWINGS_V1===\n';

export interface VtdDrawings {
  lines: DrawnLine[];
  vlines: DrawnVLine[];
  rects: DrawnRect[];
  trendLines: DrawnTrendLine[];
  texts: DrawnText[];
}

export function splitVtdBundle(text: string): { csvText: string; drawings: VtdDrawings | null } {
  const idx = text.indexOf(VTD_MARKER);
  if (idx === -1) return { csvText: text, drawings: null };
  const csvText = text.slice(0, idx);
  try {
    const parsed = JSON.parse(text.slice(idx + VTD_MARKER.length));
    const drawings: VtdDrawings = {
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      vlines: Array.isArray(parsed.vlines) ? parsed.vlines : [],
      rects: Array.isArray(parsed.rects) ? parsed.rects : [],
      // 旧形式（トレンドライン/テキスト機能追加前）のファイルには無いため空配列にフォールバックする
      trendLines: Array.isArray(parsed.trendLines) ? parsed.trendLines : [],
      texts: Array.isArray(parsed.texts) ? parsed.texts : [],
    };
    return { csvText, drawings };
  } catch {
    // 末尾が壊れていてもCSV部分だけは活かす
    return { csvText, drawings: null };
  }
}

export function buildVtdBundle(csvText: string, drawings: VtdDrawings): string {
  const body = csvText.endsWith('\n') ? csvText : csvText + '\n';
  return body + VTD_MARKER + JSON.stringify(drawings);
}
