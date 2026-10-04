// 全角数字（U+FF10-FF19）を半角に矯正する。日付移動の年/月/日欄はIME入力で全角になりがちなため
export function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

// 年/月/日を別々の入力欄から受け取ってUnix秒へ変換。年は空欄可で、その場合は
// currentYearSec（現在リプレイ中の足の時刻）が指す年を補う
export function buildJumpSec(yearStr: string, monthStr: string, dayStr: string, currentYearSec?: number): number | null {
  const moStr = monthStr.trim(), dStr = dayStr.trim();
  if (!/^\d{1,2}$/.test(moStr) || !/^\d{1,2}$/.test(dStr)) return null;
  const mo = +moStr, d = +dStr;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const yStr = yearStr.trim();
  if (yStr && !/^\d{4}$/.test(yStr)) return null;
  const y = yStr ? +yStr : new Date((currentYearSec ?? 0) * 1000).getUTCFullYear();
  const sec = Math.floor(Date.UTC(y, mo - 1, d, 0, 0) / 1000);
  // Date.UTCは月/日が範囲外でも繰り上げてしまう（例: 2/30→3/2）。往復させて弾く
  const check = new Date(sec * 1000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return sec;
}
