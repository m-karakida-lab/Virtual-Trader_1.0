import type { ClosedTrade } from '../types';
import { inferPipSize } from './pips';

// 保有期間（決済-建玉）の表示用フォーマット。主要な2単位だけに絞る（分＋秒等の細かすぎる
// 表示は避ける。数分〜数ヶ月と幅が広いトレードを同じ書式で扱うための簡易表現）
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const totalMin = Math.floor(sec / 60);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分`);
  return parts.slice(0, 2).join(' ');
}

// 獲得（損失）pips。方向（BUY/SELL）を考慮した符号付きの値幅をpip単位で表す
export function tradePips(t: ClosedTrade): number {
  const dir = t.side === 'BUY' ? 1 : -1;
  return ((t.closePrice - t.openPrice) * dir) / inferPipSize(t.openPrice);
}
