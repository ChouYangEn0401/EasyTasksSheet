import { describe, expect, it } from 'vitest';
import { taskUpdateInput, type Task } from '../../shared/tasks.ts';
import {
  applyTaskPatch,
  describeTaskUpdate,
  fieldKeysOf,
  fieldLabel,
  TASK_FIELD_LABELS,
  findConflicts,
  isNoop,
  mergeChanges,
  pickFields,
  toTaskPatch,
} from './taskUndoModel.ts';

const task = (over: Partial<Task> = {}): Task => ({
  id: 1,
  projectId: 1,
  title: '寫報告',
  description: '',
  statusId: 1,
  assigneeId: null,
  priority: 'none',
  startDate: null,
  dueDate: null,
  estimateHours: null,
  progress: 0,
  sortOrder: 1,
  custom: { '7': 'a' },
  createdBy: 1,
  updatedBy: 1,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('欄位攤平', () => {
  it('fieldKeysOf / pickFields / toTaskPatch：custom 逐鍵，缺值視為 null', () => {
    const keys = fieldKeysOf({ title: 'x', custom: { '7': 'b', '9': true } });
    expect(keys).toEqual(['title', 'custom.7', 'custom.9']);
    expect(pickFields(task(), keys)).toEqual({ title: '寫報告', 'custom.7': 'a', 'custom.9': null });
    expect(toTaskPatch({ title: '寫報告', 'custom.7': 'a', 'custom.9': null })).toEqual({
      title: '寫報告',
      custom: { '7': 'a', '9': null },
    });
  });

  it('applyTaskPatch：custom 合併、null 清除', () => {
    const next = applyTaskPatch(task(), { statusId: 2, custom: { '7': null, '8': 3 } });
    expect(next.statusId).toBe(2);
    expect(next.custom).toEqual({ '8': 3 });
  });

  it('isNoop', () => {
    expect(isNoop({ before: { title: 'a' }, after: { title: 'a' } })).toBe(true);
    expect(isNoop({ before: { title: 'a' }, after: { title: 'b' } })).toBe(false);
  });
});

describe('衝突判斷 findConflicts', () => {
  it('目前值與預期值相同 → 無衝突', () => {
    expect(findConflicts({ title: 'B', statusId: 2 }, { title: 'B', statusId: 2 })).toEqual([]);
  });

  it('被別人改過的欄位列出目前值', () => {
    expect(findConflicts({ title: 'C', statusId: 2 }, { title: 'B', statusId: 2 })).toEqual([
      { field: 'title', expected: 'B', current: 'C' },
    ]);
  });

  it('null 與缺值視為相同；排序值不比對', () => {
    expect(findConflicts({ dueDate: null }, { dueDate: undefined })).toEqual([]);
    expect(findConflicts({ sortOrder: 5, 'custom.7': ['x'] }, { sortOrder: 2, 'custom.7': ['x'] })).toEqual(
      [],
    );
  });
});

describe('mergeChanges（連續編輯 / 同一次拖曳）', () => {
  it('同一任務：before 取最早、after 取最新；不同任務各自保留', () => {
    const merged = mergeChanges(
      [{ id: 1, title: 'A', before: { title: 'A' }, after: { title: 'AB' } }],
      [
        {
          id: 1,
          title: 'ABC',
          before: { title: 'AB', dueDate: null },
          after: { title: 'ABC', dueDate: '2026-01-01' },
        },
        { id: 2, title: 'X', before: { sortOrder: 1 }, after: { sortOrder: 2 } },
      ],
    );
    expect(merged).toEqual([
      {
        id: 1,
        title: 'ABC',
        before: { title: 'A', dueDate: null },
        after: { title: 'ABC', dueDate: '2026-01-01' },
      },
      { id: 2, title: 'X', before: { sortOrder: 1 }, after: { sortOrder: 2 } },
    ]);
  });
});

describe('describeTaskUpdate 文案', () => {
  const statusName = (id: number) => ({ 1: '待辦', 2: '進行中' })[id];
  it('狀態變更 → 把『X』移到『進行中』', () => {
    expect(
      describeTaskUpdate(
        [
          { id: 3, title: '鄰居', before: { sortOrder: 1 }, after: { sortOrder: 2 } },
          {
            id: 1,
            title: '寫報告',
            before: { statusId: 1, sortOrder: 1 },
            after: { statusId: 2, sortOrder: 3 },
          },
        ],
        { statusName },
      ),
    ).toBe('把『寫報告』移到『進行中』');
  });
  it('單一欄位、只有排序、多欄位', () => {
    expect(
      describeTaskUpdate([{ id: 1, title: '寫報告', before: { title: 'a' }, after: { title: 'b' } }]),
    ).toBe('修改『寫報告』的標題');
    expect(
      describeTaskUpdate([{ id: 1, title: '寫報告', before: { sortOrder: 1 }, after: { sortOrder: 2 } }]),
    ).toBe('調整『寫報告』的順序');
    expect(
      describeTaskUpdate(
        [{ id: 1, title: '寫報告', before: { 'custom.7': null }, after: { 'custom.7': 'x' } }],
        { propertyName: () => '客戶' },
      ),
    ).toBe('修改『寫報告』的客戶');
    expect(
      describeTaskUpdate([
        {
          id: 1,
          title: '寫報告',
          before: { title: 'a', dueDate: null },
          after: { title: 'b', dueDate: '2026-01-01' },
        },
      ]),
    ).toBe('修改『寫報告』的 2 個欄位');
  });
});

describe('欄位中文名稱', () => {
  it('任務所有可 PATCH 的欄位都有中文標籤（不會在復原文案露出英文欄位名）', () => {
    const keys = Object.keys(taskUpdateInput.shape).filter((k) => k !== 'custom');
    const missing = keys.filter((k) => !(k in TASK_FIELD_LABELS));
    expect(missing).toEqual([]);
    for (const k of keys) expect(fieldLabel(k)).not.toMatch(/[A-Za-z]/);
  });

  it('鎖定描述的文案為中文', () => {
    expect(
      describeTaskUpdate([
        { id: 1, title: '寫報告', before: { descriptionLocked: false }, after: { descriptionLocked: true } },
      ]),
    ).toBe('修改『寫報告』的描述鎖定');
  });
});
