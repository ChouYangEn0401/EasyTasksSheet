import { describe, expect, it } from 'vitest';
import type { Task } from '../../../shared/tasks.ts';
import { emptyFilters } from '../../lib/filters.ts';
import {
  arrayMove,
  cardAriaLabel,
  columnId,
  dueDisplay,
  findColumn,
  formatHours,
  groupTaskIds,
  matchesFilters,
  moveToColumn,
  navTarget,
  parseColumnId,
  planSortOrders,
  quickAddDefaults,
  sumHours,
  visibleStatuses,
} from './kanbanModel.ts';

const task = (over: Partial<Task> & { id: number }): Task => ({
  projectId: 1,
  title: `任務 ${over.id}`,
  description: '',
  statusId: 1,
  assigneeId: null,
  priority: 'none',
  startDate: null,
  dueDate: null,
  estimateHours: null,
  progress: 0,
  sortOrder: over.id,
  custom: {},
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('欄 id', () => {
  it('columnId / parseColumnId 互轉', () => {
    expect(parseColumnId(columnId(7))).toBe(7);
    expect(parseColumnId(7)).toBeNull();
    expect(parseColumnId('x-1')).toBeNull();
  });
});

describe('groupTaskIds / visibleStatuses', () => {
  it('依 sortOrder、id 排序分欄，未知狀態略過', () => {
    const tasks = [
      task({ id: 1, statusId: 2, sortOrder: 5 }),
      task({ id: 2, statusId: 1, sortOrder: 3 }),
      task({ id: 3, statusId: 1, sortOrder: 1 }),
      task({ id: 4, statusId: 1, sortOrder: 1 }),
      task({ id: 5, statusId: 9 }),
    ];
    expect(groupTaskIds(tasks, [1, 2, 3])).toEqual({ 1: [3, 4, 2], 2: [1], 3: [] });
  });
  it('有狀態篩選時只留被選取的欄', () => {
    const statuses = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(visibleStatuses(statuses, emptyFilters())).toHaveLength(3);
    expect(visibleStatuses(statuses, { ...emptyFilters(), status: [3, 1] })).toEqual([{ id: 1 }, { id: 3 }]);
  });
});

describe('moveToColumn / findColumn / arrayMove', () => {
  const cols = { 1: [1, 2, 3], 2: [4] };
  it('跨欄移動到指定位置', () => {
    expect(moveToColumn(cols, 2, 1, 2, 0)).toEqual({ 1: [1, 3], 2: [2, 4] });
    expect(moveToColumn(cols, 2, 1, 2, 9)).toEqual({ 1: [1, 3], 2: [4, 2] });
  });
  it('同欄移動', () => {
    expect(moveToColumn(cols, 1, 1, 1, 2)).toEqual({ 1: [2, 3, 1], 2: [4] });
  });
  it('findColumn', () => {
    expect(findColumn(cols, 4)).toBe(2);
    expect(findColumn(cols, 99)).toBeNull();
  });
  it('arrayMove', () => {
    expect(arrayMove([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
  });
});

describe('planSortOrders', () => {
  const p = (id: number, sortOrder: number) => ({ id, sortOrder });
  it('空欄取 0', () => {
    expect(planSortOrders([p(9, 42)], 0)).toEqual([p(9, 0)]);
  });
  it('欄首取首張 − 1、欄尾取末張 + 1', () => {
    expect(planSortOrders([p(9, 42), p(1, 3), p(2, 5)], 0)).toEqual([p(9, 2)]);
    expect(planSortOrders([p(1, 3), p(2, 5), p(9, 0)], 2)).toEqual([p(9, 6)]);
  });
  it('中間取前後中間值', () => {
    expect(planSortOrders([p(1, 3), p(9, 0), p(2, 4)], 1)).toEqual([p(9, 3.5)]);
  });
  it('前後同值時整欄重新編號', () => {
    const res = planSortOrders([p(1, 2), p(9, 0), p(2, 2), p(3, 3)], 1);
    expect(res).toEqual([p(9, 3), p(2, 4), p(3, 5)]);
  });
});

describe('navTarget', () => {
  const cols = [[1, 2, 3], [], [4, 5]];
  it('上下、Home / End', () => {
    expect(navTarget(cols, 2, 'ArrowUp')).toBe(1);
    expect(navTarget(cols, 1, 'ArrowUp')).toBeNull();
    expect(navTarget(cols, 2, 'ArrowDown')).toBe(3);
    expect(navTarget(cols, 3, 'ArrowDown')).toBeNull();
    expect(navTarget(cols, 3, 'Home')).toBe(1);
    expect(navTarget(cols, 1, 'End')).toBe(3);
  });
  it('左右跳過空欄並取位置最接近的卡片', () => {
    expect(navTarget(cols, 3, 'ArrowRight')).toBe(5);
    expect(navTarget(cols, 4, 'ArrowLeft')).toBe(1);
    expect(navTarget(cols, 4, 'ArrowRight')).toBeNull();
  });
});

describe('matchesFilters / quickAddDefaults', () => {
  const t = task({ id: 1, title: 'Design Login', projectId: 2, assigneeId: null, statusId: 3 });
  it('依各條件比對', () => {
    expect(matchesFilters(t, emptyFilters())).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), q: 'login' })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), q: 'xyz' })).toBe(false);
    expect(matchesFilters(t, { ...emptyFilters(), project: [1] })).toBe(false);
    expect(matchesFilters(t, { ...emptyFilters(), assignee: ['none'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), assignee: [5] })).toBe(false);
    expect(matchesFilters(t, { ...emptyFilters(), status: [3] })).toBe(true);
  });
  it('單選專案 / 負責人才帶入，排在欄底', () => {
    expect(quickAddDefaults(2, emptyFilters(), null)).toEqual({ statusId: 2, sortOrder: 0 });
    expect(quickAddDefaults(2, { ...emptyFilters(), project: [4], assignee: [7] }, 10)).toEqual({
      statusId: 2,
      sortOrder: 11,
      projectId: 4,
      assigneeId: 7,
    });
    expect(quickAddDefaults(2, { ...emptyFilters(), project: [4, 5], assignee: ['none'] }, 1)).toEqual({
      statusId: 2,
      sortOrder: 2,
    });
  });
});

describe('顯示格式', () => {
  const now = new Date(2026, 10, 24, 10).getTime();
  it('formatHours / sumHours', () => {
    expect(formatHours(6)).toBe('6h');
    expect(formatHours(1.25)).toBe('1.3h');
    expect(sumHours([{ estimateHours: 2 }, { estimateHours: null }, { estimateHours: 1.5 }])).toBe(3.5);
  });
  it('dueDisplay：逾期、今天、跨年、done 欄一般色', () => {
    expect(dueDisplay(null, false, now)).toBeNull();
    expect(dueDisplay('2026-11-28', false, now)).toEqual({ text: '11/28', tone: 'normal' });
    expect(dueDisplay('2026-11-24', false, now)).toEqual({ text: '今天', tone: 'today' });
    expect(dueDisplay('2026-11-20', false, now)).toEqual({ text: '11/20', tone: 'overdue' });
    expect(dueDisplay('2026-11-20', true, now)).toEqual({ text: '11/20', tone: 'normal' });
    expect(dueDisplay('2027-01-02', false, now)).toEqual({ text: '2027/01/02', tone: 'normal' });
  });
  it('cardAriaLabel', () => {
    expect(
      cardAriaLabel(task({ id: 1, title: 'A', dueDate: '2026-11-28', estimateHours: 6 }), '王小明'),
    ).toBe('A，負責人 王小明，到期 2026/11/28，預估 6 小時');
    expect(cardAriaLabel(task({ id: 1, title: 'B' }), null)).toBe('B，負責人 未指派，到期 無，預估 未估');
  });
});
