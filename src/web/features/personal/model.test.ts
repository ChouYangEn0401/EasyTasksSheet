import { describe, expect, it } from 'vitest';
import type { Status } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import { assignedRows, dueLabel, sectionText } from './model.ts';

const statuses = new Map<number, Status>([
  [1, { id: 1, name: '待辦', color: 'gray', category: 'todo', sortOrder: 1, createdAt: 0, updatedAt: 0 }],
  [4, { id: 4, name: '完成', color: 'green', category: 'done', sortOrder: 4, createdAt: 0, updatedAt: 0 }],
]);

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  projectId: 1,
  title: `T${id}`,
  description: '',
  statusId: 1,
  assigneeId: 1,
  priority: 'none',
  startDate: null,
  dueDate: null,
  estimateHours: null,
  progress: 0,
  sortOrder: id,
  custom: {},
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('assignedRows', () => {
  const list = [
    task(1),
    task(2, { dueDate: '2026-12-02' }),
    task(3, { dueDate: '2026-11-28' }),
    task(4, { statusId: 4, updatedAt: 10 }),
    task(5, { statusId: 4, updatedAt: 20 }),
  ];
  it('預設只列未完成，到期日近→遠、無日期排最後', () => {
    expect(assignedRows(list, statuses, false).map((t) => t.id)).toEqual([3, 2, 1]);
  });
  it('顯示已完成時接在最後（最近更新者在前）', () => {
    expect(assignedRows(list, statuses, true).map((t) => t.id)).toEqual([3, 2, 1, 5, 4]);
  });
});

describe('dueLabel', () => {
  const now = Date.parse('2026-11-24T10:00:00+08:00');
  it('同年 MM/DD、跨年含年份、無日期為—', () => {
    expect(dueLabel('2026-11-28', false, now)).toEqual({ text: '11/28', overdue: false });
    expect(dueLabel('2027-01-03', false, now)).toEqual({ text: '2027/01/03', overdue: false });
    expect(dueLabel(null, false, now)).toEqual({ text: '—', overdue: false });
  });
  it('逾期只對未完成標示', () => {
    expect(dueLabel('2026-11-20', false, now).overdue).toBe(true);
    expect(dueLabel('2026-11-20', true, now).overdue).toBe(false);
    expect(dueLabel('2026-11-24', false, now).overdue).toBe(false);
  });
});

describe('sectionText', () => {
  it('檢視他人時文案換成成員名稱', () => {
    expect(sectionText(null).assigned).toBe('指派給我的任務');
    expect(sectionText('王小明')).toMatchObject({
      assigned: '指派給 王小明 的任務',
      pinned: '王小明 標記的任務',
      todos: '王小明 的自由待辦',
    });
  });
});
