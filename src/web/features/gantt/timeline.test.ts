import { describe, expect, it } from 'vitest';
import { buildGroups, groupSpan, parseGroupBy } from './grouping.ts';
import {
  addDays,
  applyDrag,
  computeRange,
  datePatch,
  formatSpan,
  fromDay,
  headerCells,
  taskSpan,
  toDay,
  weekdayIndex,
} from './timeline.ts';

const d = toDay;

describe('timeline', () => {
  it('日期與日序互轉', () => {
    expect(fromDay(d('2026-11-24'))).toBe('2026-11-24');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(weekdayIndex(d('2026-11-23'))).toBe(0); // 週一
    expect(weekdayIndex(d('2026-11-29'))).toBe(6); // 週日
  });

  it('taskSpan：單一日期視為 1 天，兩者皆無為 null', () => {
    expect(taskSpan({ startDate: '2026-11-20', dueDate: '2026-11-28' })).toEqual({
      start: d('2026-11-20'),
      end: d('2026-11-28'),
      single: false,
    });
    expect(taskSpan({ startDate: null, dueDate: '2026-11-28' })).toEqual({
      start: d('2026-11-28'),
      end: d('2026-11-28'),
      single: true,
    });
    expect(taskSpan({ startDate: null, dueDate: null })).toBeNull();
  });

  it('繪製範圍：至少今天 −14 至 +56，對齊整週 / 整月', () => {
    const today = '2026-11-24'; // 週二
    const r = computeRange([], today, 'week');
    expect(fromDay(r.start)).toBe('2026-11-09'); // 11/10 所在週的週一
    expect(weekdayIndex(r.end)).toBe(0);
    expect(r.end).toBeGreaterThan(d(today) + 56);
    const withTask = computeRange([{ startDate: '2026-06-03', dueDate: '2027-03-01' }], today, 'month');
    expect(fromDay(withTask.start)).toBe('2026-06-01');
    expect(fromDay(withTask.end)).toBe('2027-04-01');
  });

  it('表頭：日 / 週 / 月', () => {
    const range = { start: d('2026-11-30'), end: d('2026-12-14') };
    const day = headerCells(range, 'day');
    expect(day.top.map((c) => [c.label, c.days])).toEqual([
      ['2026 年 11 月', 1],
      ['2026 年 12 月', 13],
    ]);
    expect(day.bottom[0]).toMatchObject({ label: '30 一', weekend: false });
    expect(day.bottom[5]).toMatchObject({ label: '5 六', weekend: true });
    const week = headerCells(range, 'week');
    expect(week.bottom.map((c) => c.label)).toEqual(['11/30', '12/7']);
    const month = headerCells({ start: d('2026-11-01'), end: d('2027-02-01') }, 'month');
    expect(month.top.map((c) => c.label)).toEqual(['2026 年', '2027 年']);
    expect(month.bottom.map((c) => [c.label, c.days])).toEqual([
      ['11 月', 30],
      ['12 月', 31],
      ['1 月', 31],
    ]);
  });

  it('拖曳：平移、改開始 / 到期，最短 1 天', () => {
    const span = { start: 10, end: 14 };
    expect(applyDrag(span, 'move', 3)).toEqual({ start: 13, end: 17 });
    expect(applyDrag(span, 'start', -2)).toEqual({ start: 8, end: 14 });
    expect(applyDrag(span, 'start', 9)).toEqual({ start: 14, end: 14 });
    expect(applyDrag(span, 'end', -9)).toEqual({ start: 10, end: 10 });
  });

  it('datePatch 只送有變動的欄位，單一日期會補上缺的日期', () => {
    const t = { startDate: '2026-11-20', dueDate: '2026-11-28' };
    expect(datePatch(t, { start: d('2026-11-20'), end: d('2026-11-30') })).toEqual({ dueDate: '2026-11-30' });
    expect(
      datePatch({ startDate: null, dueDate: '2026-11-28' }, { start: d('2026-11-28'), end: d('2026-11-28') }),
    ).toEqual({ startDate: '2026-11-28' });
    expect(formatSpan(d('2026-11-20'), d('2026-11-28'))).toBe('11/20 → 11/28（9 天）');
  });
});

describe('grouping', () => {
  const tasks = [
    { id: 1, projectId: 1, assigneeId: 10, startDate: '2026-11-20', dueDate: '2026-11-25' },
    { id: 2, projectId: 2, assigneeId: null, startDate: '2026-11-18', dueDate: null },
    { id: 3, projectId: 1, assigneeId: 10, startDate: null, dueDate: null },
    { id: 4, projectId: 1, assigneeId: 99, startDate: '2026-11-01', dueDate: '2026-11-02' },
  ];
  const ctx = {
    members: [
      { id: 11, displayName: '無排程' },
      { id: 10, displayName: '王' },
    ],
    projects: [
      { id: 2, name: 'P2', color: 'red' },
      { id: 1, name: 'P1', color: 'blue' },
    ],
    userName: (id: number) => (id === 99 ? '停用者' : undefined),
  };

  it('負責人分組：保留成員順序、無排程成員仍列出、未指派最後、未排程不納入', () => {
    const g = buildGroups(tasks, 'assignee', ctx);
    expect(g.map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([
      ['無排程', []],
      ['王', [1]],
      ['停用者', [4]],
      ['未指派', [2]],
    ]);
  });

  it('專案分組依專案順序，不分組依開始日排序', () => {
    expect(buildGroups(tasks, 'project', ctx).map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([
      ['P2', [2]],
      ['P1', [4, 1]],
    ]);
    expect(buildGroups(tasks, 'none', ctx)[0]!.tasks.map((t) => t.id)).toEqual([4, 2, 1]);
  });

  it('groupSpan 與 parseGroupBy', () => {
    expect(groupSpan(tasks)).toEqual({ start: d('2026-11-01'), end: d('2026-11-25') });
    expect(groupSpan([])).toBeNull();
    expect(parseGroupBy('project')).toBe('project');
    expect(parseGroupBy('x')).toBe('assignee');
  });
});
