// CSV（Axiory MT4形式）のブローカーサーバー時間 → 日本時間(JST, UTC+9) への変換。
// ブローカーはEUの夏時間ルール（3月最終日曜〜10月最終日曜）に従い GMT+2(冬) / GMT+3(夏) で運用されている前提。
// 遷移日当日の正確な切替時刻（分単位）までは追わず、日単位の近似で判定する。

// year年 month（0始まり）の最終日曜日の日付（1〜31）。month は必ず31日ある月（2=3月, 9=10月）のみを想定
function lastSundayOfMonth(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 31));
  return 31 - last.getUTCDay();
}

// 「ブローカー時間として解釈した」unixSec が夏時間期間内かどうかから GMT オフセット（2 or 3）を返す
function brokerOffsetHours(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  const year = d.getUTCFullYear();
  const dstStart = Date.UTC(year, 2, lastSundayOfMonth(year, 2)) / 1000; // 3月最終日曜 00:00
  const dstEnd   = Date.UTC(year, 9, lastSundayOfMonth(year, 9)) / 1000; // 10月最終日曜 00:00
  return (unixSec >= dstStart && unixSec < dstEnd) ? 3 : 2;
}

// ブローカー時間の unixSec を、同じ「naive UTC」表現のまま JST 相当の値にずらす
// （getUTCHours 等の既存の表示コードをそのまま使えるようにするため、実際の UTC には変換しない）
export function brokerToJST(unixSec: number): number {
  return unixSec + (9 - brokerOffsetHours(unixSec)) * 3600;
}
