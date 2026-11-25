import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatDateTime, formatRelative, initialOf, isOverdue, truncate } from './format.ts';

const at = (s: string) => new Date(s).getTime();

describe('formatRelative', () => {
  const now = at('2026-11-24T14:32:00');
  it.each([
    ['2026-11-24T14:31:30', '剛剛'],
    ['2026-11-24T14:20:00', '12 分鐘前'],
    ['2026-11-24T09:00:00', '5 小時前'],
    ['2026-11-23T20:00:00', '昨天'],
    ['2026-11-20T10:00:00', '4 天前'],
    ['2026-11-10T10:00:00', '11/10'],
    ['2025-12-31T10:00:00', '2025/12/31'],
  ])('%s → %s', (input, expected) => {
    expect(formatRelative(at(input), now)).toBe(expected);
  });
});

describe('其他格式', () => {
  it('formatDateTime', () => {
    expect(formatDateTime(at('2026-11-24T09:05:00'))).toBe('2026/11/24 09:05');
  });
  it('formatDateOnly', () => {
    expect(formatDateOnly('2026-11-28')).toBe('2026/11/28');
    expect(formatDateOnly(null)).toBe('');
  });
  it('isOverdue 不含今天', () => {
    const now = at('2026-11-24T10:00:00');
    expect(isOverdue('2026-11-23', now)).toBe(true);
    expect(isOverdue('2026-11-24', now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });
  it('initialOf', () => {
    expect(initialOf('王小明')).toBe('王');
    expect(initialOf('alice')).toBe('A');
    expect(initialOf('  ')).toBe('?');
  });
  it('truncate 以字元計並去頭尾空白', () => {
    expect(truncate('  abc  ')).toBe('abc');
    expect(truncate('一二三四五', 3)).toBe('一二三…');
    expect(truncate('😀😀😀', 2)).toBe('😀😀…');
    expect(truncate('一二三', 3)).toBe('一二三');
  });
});
