// チャートへの書き込み（水平線・垂直線・四角形）を、読み込んだCSV本体と1つのファイルに
// まとめて保存・復元するための最小限のバンドル形式。
//
// 仕組みは単純: CSVの行データをそのまま残し、末尾にこのファイル専用の区切り文字列を1行
// 追加し、その後ろに描画データのJSONを1つ書くだけ。区切り文字列より前はDuckDBにとって
// 普通のCSVそのものなので、read_csv側の実装には一切手を入れていない。
// マーカーが無いファイル（証券会社の生CSV）は今まで通りそのまま読み込める。
import type { DrawnLine, DrawnVLine, DrawnRect, DrawnTrendLine, DrawnArrow, DrawnBrush, DrawnText, ClosedTrade } from '../types';

const VTD_MARKER = '\n===VT_DRAWINGS_V1===\n';

export interface VtdDrawings {
  lines: DrawnLine[];
  vlines: DrawnVLine[];
  rects: DrawnRect[];
  trendLines: DrawnTrendLine[];
  arrows: DrawnArrow[];
  brushes: DrawnBrush[];
  texts: DrawnText[];
  // 決済済み取引履歴（チャート上のエントリー/決済マーカー）。建玉中のポジション・未約定注文・
  // 残高/初期残高等は「その時点のCSV+描画だけを純粋に保つ」方針により対象外（ユーザーと合意済み）
  closedTrades: ClosedTrade[];
  // 保存時点で表示していた最新足（リプレイのcursorが指す足）のUnix秒。読み込み時の時間軸が
  // 保存時と異なっていても復元できるよう、配列インデックスではなく時刻そのものを保存する。
  // 未指定（旧形式のファイル）の場合は従来通り先頭（cursor:0）から始める
  cursorTime?: number;
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
      // 旧形式（トレンドライン/矢印/ブラシ/テキスト機能追加前）のファイルには無いため空配列にフォールバックする
      trendLines: Array.isArray(parsed.trendLines) ? parsed.trendLines : [],
      arrows: Array.isArray(parsed.arrows) ? parsed.arrows : [],
      brushes: Array.isArray(parsed.brushes) ? parsed.brushes : [],
      texts: Array.isArray(parsed.texts) ? parsed.texts : [],
      // 取引履歴保存より前のファイルには無いため空配列にフォールバックする
      closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [],
      // 再生位置保存より前のファイルには無いためundefinedのまま（呼び出し側でcursor:0にフォールバック）
      cursorTime: typeof parsed.cursorTime === 'number' ? parsed.cursorTime : undefined,
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
