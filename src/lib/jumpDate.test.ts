import { describe, expect, it } from 'vitest';
import { buildJumpSec, toHalfWidthDigits } from './jumpDate';

const utc = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

describe('toHalfWidthDigits', () => {
  it('全角数字を半角にし、他の文字は触らない', () => {
    expect(toHalfWidthDigits('２０１６')).toBe('2016');
    expect(toHalfWidthDigits('1２a')).toBe('12a');
    expect(toHalfWidthDigits('')).toBe('');
  });
});

describe('buildJumpSec', () => {
  it('年月日からUTC 0時のUnix秒', () => {
    expect(buildJumpSec('2016', '2', '18')).toBe(utc(2016, 2, 18));
    expect(buildJumpSec(' 2016 ', ' 02 ', ' 18 ')).toBe(utc(2016, 2, 18));
  });

  it('年が空欄なら現在位置の年を使う', () => {
    expect(buildJumpSec('', '3', '1', utc(2019, 7, 4))).toBe(utc(2019, 3, 1));
  });

  it('存在しない日付・範囲外・数字以外はnull', () => {
    expect(buildJumpSec('2016', '2', '30')).toBeNull(); // 2/30は3/1に繰り上がらせない
    expect(buildJumpSec('2015', '2', '29')).toBeNull(); // 平年
    expect(buildJumpSec('2016', '2', '29')).toBe(utc(2016, 2, 29)); // 閏年
    expect(buildJumpSec('2016', '13', '1')).toBeNull();
    expect(buildJumpSec('2016', '0', '1')).toBeNull();
    expect(buildJumpSec('2016', '1', '32')).toBeNull();
    expect(buildJumpSec('16', '1', '1')).toBeNull(); // 年は4桁
    expect(buildJumpSec('2016', '', '1')).toBeNull();
    expect(buildJumpSec('2016', 'a', '1')).toBeNull();
  });
});
