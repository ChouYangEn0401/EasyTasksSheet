import { describe, expect, it } from 'vitest';
import { compareOverviewMembers, sortOverviewMembers } from './sortMembers.ts';

function mk(id: number, displayName: string, idle: boolean, todo: number, overdue: number) {
  return { user: { id, displayName }, idle, counts: { todo }, overdue };
}

const names = (xs: { user: { displayName: string } }[]) => xs.map((x) => x.user.displayName);

describe('sortOverviewMembers', () => {
  it('無任務在前（待辦少 → 多），進行中在後（逾期多 → 少）', () => {
    const sorted = sortOverviewMembers([
      mk(1, 'A', false, 0, 1),
      mk(2, 'B', true, 3, 0),
      mk(3, 'C', false, 0, 5),
      mk(4, 'D', true, 0, 2),
    ]);
    expect(names(sorted)).toEqual(['D', 'B', 'C', 'A']);
  });

  it('同條件依 zh-Hant 定序排列顯示名稱，與 localeCompare(…, "zh-Hant") 一致', () => {
    const input = ['陳大文', '王小明', '林志玲', '張三', 'Amy', 'bob'].map((n, i) =>
      mk(i + 1, n, true, 0, 0),
    );
    const expected = input.map((m) => m.user.displayName).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    expect(names(sortOverviewMembers(input))).toEqual(expected);
    // 後端以 id 排的順序不影響結果
    expect(names(sortOverviewMembers([...input].reverse()))).toEqual(expected);
    // 拉丁字母不分大小寫
    expect(names(sortOverviewMembers([mk(1, 'bob', true, 0, 0), mk(2, 'Amy', true, 0, 0)]))).toEqual([
      'Amy',
      'bob',
    ]);
  });

  it('名稱條件只在同數值條件間生效', () => {
    const sorted = sortOverviewMembers([
      mk(1, 'Amy', false, 0, 1),
      mk(2, 'Zed', false, 0, 2),
      mk(3, 'Bob', true, 1, 0),
    ]);
    expect(names(sorted)).toEqual(['Bob', 'Zed', 'Amy']);
  });

  it('同名時依 id，且不改動原陣列', () => {
    const input = [mk(9, '同名', true, 0, 0), mk(2, '同名', true, 0, 0)];
    expect(sortOverviewMembers(input).map((m) => m.user.id)).toEqual([2, 9]);
    expect(input.map((m) => m.user.id)).toEqual([9, 2]);
    expect(compareOverviewMembers(input[0]!, input[0]!)).toBe(0);
  });
});
