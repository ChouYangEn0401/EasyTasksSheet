import { describe, expect, it } from 'vitest';
import type { Task } from '../../../shared/tasks.ts';
import {
  announceDnd,
  dropId,
  groupFieldPatch,
  keyboardSlots,
  markerFor,
  originOf,
  parseDragId,
  dragId,
  planDrop,
  resolveTarget,
  slotDropId,
  type DropTarget,
} from './listDndModel.ts';
import type { TaskGroup } from './model.ts';

const task = (id: number, sortOrder: number, extra: Partial<Task> = {}): Task =>
  ({ id, title: `T${id}`, sortOrder, statusId: 1, assigneeId: null, projectId: 1, ...extra }) as Task;

/** 依狀態分組：待辦（空）、進行中（1,2,3）、完成（4） */
const statusGroups = (): TaskGroup[] => [
  { key: 'status:1', mode: 'status', id: 1, tasks: [] },
  { key: 'status:2', mode: 'status', id: 2, tasks: [task(1, 1), task(2, 2), task(3, 3)] },
  { key: 'status:3', mode: 'status', id: 3, tasks: [task(4, 10)] },
];

describe('drag / drop ids', () => {
  it('round-trips the drag id', () => {
    expect(parseDragId(dragId(42))).toBe(42);
    expect(parseDragId('dnd-row:1')).toBeNull();
    expect(parseDragId(3)).toBeNull();
  });
});

describe('resolveTarget', () => {
  const groups = statusGroups();
  const origin = originOf(groups, 2)!;

  it('finds the origin', () => {
    expect(origin).toEqual({ groupKey: 'status:2', index: 1 });
  });

  it('row: before / after by pointer half', () => {
    const over = { kind: 'row' as const, groupKey: 'status:2', taskId: 3 };
    // 移除 2 後為 [1,3]：3 在索引 1
    expect(resolveTarget({ groups, activeId: 2, origin, over, below: false, sortLocked: false })).toEqual({
      groupKey: 'status:2',
      index: 1,
    });
    expect(resolveTarget({ groups, activeId: 2, origin, over, below: true, sortLocked: false })).toEqual({
      groupKey: 'status:2',
      index: 2,
    });
  });

  it('row over itself = origin', () => {
    const over = { kind: 'row' as const, groupKey: 'status:2', taskId: 2 };
    expect(resolveTarget({ groups, activeId: 2, origin, over, sortLocked: false })).toEqual(origin);
  });

  it('empty group: header and insert row both target index 0', () => {
    expect(
      resolveTarget({
        groups,
        activeId: 2,
        origin,
        over: { kind: 'group', groupKey: 'status:1' },
        sortLocked: false,
      }),
    ).toEqual({ groupKey: 'status:1', index: 0 });
    expect(
      resolveTarget({
        groups,
        activeId: 2,
        origin,
        over: { kind: 'insert', groupKey: 'status:1' },
        sortLocked: false,
      }),
    ).toEqual({ groupKey: 'status:1', index: 0 });
  });

  it('expanded header → top; collapsed header → end; insert → end', () => {
    const base = { groups, activeId: 2, origin, sortLocked: false };
    expect(resolveTarget({ ...base, over: { kind: 'group', groupKey: 'status:3' } })).toEqual({
      groupKey: 'status:3',
      index: 0,
    });
    expect(
      resolveTarget({ ...base, over: { kind: 'group', groupKey: 'status:3', collapsed: true } }),
    ).toEqual({
      groupKey: 'status:3',
      index: 1,
    });
    expect(resolveTarget({ ...base, over: { kind: 'insert', groupKey: 'status:3' } })).toEqual({
      groupKey: 'status:3',
      index: 1,
    });
  });

  it('sort locked: same group stays at origin, other group goes to the end', () => {
    const base = { groups, activeId: 2, origin, sortLocked: true };
    expect(resolveTarget({ ...base, over: { kind: 'row', groupKey: 'status:2', taskId: 1 } })).toEqual(
      origin,
    );
    expect(
      resolveTarget({ ...base, over: { kind: 'row', groupKey: 'status:3', taskId: 4 }, below: false }),
    ).toEqual({ groupKey: 'status:3', index: 1 });
  });

  it('unknown group → null', () => {
    expect(
      resolveTarget({
        groups,
        activeId: 2,
        origin,
        over: { kind: 'insert', groupKey: 'nope' },
        sortLocked: false,
      }),
    ).toBeNull();
  });
});

describe('groupFieldPatch', () => {
  it('maps group mode to the task field', () => {
    expect(groupFieldPatch('status', { id: 5 })).toEqual({ statusId: 5 });
    expect(groupFieldPatch('assignee', { id: 7 })).toEqual({ assigneeId: 7 });
    expect(groupFieldPatch('assignee', { id: null })).toEqual({ assigneeId: null });
    expect(groupFieldPatch('project', { id: 3 })).toEqual({ projectId: 3 });
    expect(groupFieldPatch('none', { id: null })).toEqual({});
  });
});

describe('planDrop', () => {
  const groups = statusGroups();
  const origin = originOf(groups, 2)!;
  const plan = (target: DropTarget, sortLocked = false, mode: TaskGroup['mode'] = 'status') =>
    planDrop({ groups, mode, activeId: 2, origin, target, sortLocked });

  it('same position → null', () => {
    expect(plan(origin)).toBeNull();
  });

  it('move to an empty group: status changes, sort_order 0', () => {
    expect(plan({ groupKey: 'status:1', index: 0 })).toEqual({
      taskId: 2,
      fields: { statusId: 1 },
      sortPatches: [{ id: 2, sortOrder: 0 }],
      groupChanged: true,
    });
  });

  it('move to the end of another group: last + 1', () => {
    expect(plan({ groupKey: 'status:3', index: 1 })?.sortPatches).toEqual([{ id: 2, sortOrder: 11 }]);
    expect(plan({ groupKey: 'status:3', index: 0 })?.sortPatches).toEqual([{ id: 2, sortOrder: 9 }]);
  });

  it('reorder within the group: midpoint, no field change', () => {
    // [1,3] 插在 0 → 在 1 之前：1 − 1 = 0
    expect(plan({ groupKey: 'status:2', index: 0 })).toEqual({
      taskId: 2,
      fields: {},
      sortPatches: [{ id: 2, sortOrder: 0 }],
      groupChanged: false,
    });
  });

  it('renumbers when neighbours share the same sort_order', () => {
    const g: TaskGroup[] = [
      { key: 'all', mode: 'none', id: null, tasks: [task(1, 5), task(2, 5), task(3, 5)] },
    ];
    const p = planDrop({
      groups: g,
      mode: 'none',
      activeId: 3,
      origin: { groupKey: 'all', index: 2 },
      target: { groupKey: 'all', index: 1 },
      sortLocked: false,
    });
    expect(p?.fields).toEqual({});
    expect(p?.sortPatches).toEqual([
      { id: 3, sortOrder: 6 },
      { id: 2, sortOrder: 7 },
    ]);
  });

  it('sort locked: only the group field changes; same group → null', () => {
    expect(plan({ groupKey: 'status:3', index: 1 }, true)).toEqual({
      taskId: 2,
      fields: { statusId: 3 },
      sortPatches: [],
      groupChanged: true,
    });
    expect(plan({ groupKey: 'status:2', index: 0 }, true)).toBeNull();
  });

  it('assignee grouping: moving to 未指派 sets null', () => {
    const g: TaskGroup[] = [
      { key: 'assignee:7', mode: 'assignee', id: 7, tasks: [task(1, 1, { assigneeId: 7 })] },
      { key: 'assignee:none', mode: 'assignee', id: null, tasks: [task(2, 2)] },
    ];
    const p = planDrop({
      groups: g,
      mode: 'assignee',
      activeId: 1,
      origin: { groupKey: 'assignee:7', index: 0 },
      target: { groupKey: 'assignee:none', index: 1 },
      sortLocked: false,
    });
    expect(p?.fields).toEqual({ assigneeId: null });
  });
});

describe('keyboardSlots', () => {
  const groups = statusGroups();
  const origin = originOf(groups, 2)!;

  it('lists every gap of expanded groups; collapsed groups have one slot', () => {
    const slots = keyboardSlots(groups, 2, origin, new Set(['status:3']), false);
    expect(slots).toEqual([
      { groupKey: 'status:1', index: 0, collapsed: false },
      { groupKey: 'status:2', index: 0, collapsed: false },
      { groupKey: 'status:2', index: 1, collapsed: false },
      { groupKey: 'status:2', index: 2, collapsed: false },
      { groupKey: 'status:3', index: 1, collapsed: true },
    ]);
    expect(slotDropId(slots[0]!, groups, 2, false)).toBe(dropId.insert('status:1'));
    expect(slotDropId(slots[2]!, groups, 2, false)).toBe(dropId.row(3));
    expect(slotDropId(slots[3]!, groups, 2, false)).toBe(dropId.insert('status:2'));
    expect(slotDropId(slots[4]!, groups, 2, false)).toBe(dropId.group('status:3'));
  });

  it('sort locked: one slot per group, origin kept', () => {
    const slots = keyboardSlots(groups, 2, origin, new Set(), true);
    expect(slots.map((s) => `${s.groupKey}:${s.index}`)).toEqual(['status:1:0', 'status:2:1', 'status:3:1']);
    expect(slotDropId(slots[0]!, groups, 2, true)).toBe(dropId.group('status:1'));
  });
});

describe('markerFor', () => {
  const groups = statusGroups();
  const origin = originOf(groups, 2)!;

  it('draws the line before the next task or at the insert row', () => {
    expect(markerFor({ groupKey: 'status:3', index: 0 }, origin, groups, 2, false)).toEqual({
      groupKey: 'status:3',
      beforeTaskId: 4,
      atInsert: false,
    });
    expect(markerFor({ groupKey: 'status:1', index: 0 }, origin, groups, 2, false)).toEqual({
      groupKey: 'status:1',
      beforeTaskId: null,
      atInsert: true,
    });
  });

  it('no line at the origin or while sorting', () => {
    expect(markerFor(origin, origin, groups, 2, false)?.beforeTaskId).toBeNull();
    expect(markerFor({ groupKey: 'status:3', index: 1 }, origin, groups, 2, true)).toEqual({
      groupKey: 'status:3',
      beforeTaskId: null,
      atInsert: false,
    });
    expect(markerFor(null, origin, groups, 2, false)).toBeNull();
  });
});

describe('announce', () => {
  it('uses Chinese phrases', () => {
    expect(announceDnd.pickup('A', '待辦', 1)).toBe('已拿起『A』，目前在 待辦 第 1 筆');
    expect(announceDnd.move('完成', null)).toBe('移到 完成');
    expect(announceDnd.drop('完成', 2)).toBe('已放到 完成 第 2 筆');
    expect(announceDnd.cancel('待辦', 1)).toBe('已取消，回到 待辦 第 1 筆');
  });
});
