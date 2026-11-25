/**
 * 清單拖曳（docs/design/task-list.md §13）的純函式：放置目標、鍵盤落點、欄位 patch 與 sort_order 計算。
 * 不依賴 React / DOM，方便單元測試（listDndModel.test.ts）。
 * sort_order 的前後取中值 / 重新編號沿用看板的 planSortOrders（只匯入、不修改 kanban）。
 */
import type { TaskUpdateInput } from '../../../shared/tasks.ts';
import { planSortOrders, type SortPatch } from '../kanban/kanbanModel.ts';
import type { GroupMode, TaskGroup } from './model.ts';

export type { SortPatch };

/** droppable 種類：任務列、群組標頭列、群組底部「新增任務」列 */
export type DropKind = 'row' | 'group' | 'insert';

export type DropData = {
  kind: DropKind;
  groupKey: string;
  /** kind = row 時的任務 id */
  taskId?: number;
  /** kind = group 時：該群組是否收合 */
  collapsed?: boolean;
};

/** 放置位置：群組 + 在「移除被拖曳任務後」的群組清單中的插入索引 */
export type DropTarget = { groupKey: string; index: number };

export const dragId = (taskId: number) => `dnd-task:${taskId}`;
export const dropId = {
  row: (taskId: number) => `dnd-row:${taskId}`,
  group: (groupKey: string) => `dnd-group:${groupKey}`,
  insert: (groupKey: string) => `dnd-insert:${groupKey}`,
};

export function parseDragId(id: string | number): number | null {
  if (typeof id !== 'string' || !id.startsWith('dnd-task:')) return null;
  const n = Number(id.slice(9));
  return Number.isInteger(n) ? n : null;
}

/** 群組內（排除被拖曳任務）的任務 id */
export function idsWithout(group: TaskGroup, activeId: number): number[] {
  return group.tasks.filter((t) => t.id !== activeId).map((t) => t.id);
}

/** 被拖曳任務的原位置 */
export function originOf(groups: TaskGroup[], activeId: number): DropTarget | null {
  for (const g of groups) {
    const i = g.tasks.findIndex((t) => t.id === activeId);
    if (i >= 0) return { groupKey: g.key, index: i };
  }
  return null;
}

export const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  !!a && !!b && a.groupKey === b.groupKey && a.index === b.index;

/**
 * 指標經過的 droppable → 放置位置。
 * - 任務列：依指標在列的上半 / 下半決定插在該列之前 / 之後（below）。
 * - 群組標頭：展開中 → 群組最前；收合中 → 群組最後（列看不到，加在尾端）。
 * - 「新增任務」列（含空群組唯一的列）：群組最後。
 * - 排序中（sortLocked）：群組內順序由排序決定 → 同群組一律回原位；跨群組只決定群組（放在尾端）。
 */
export function resolveTarget(args: {
  groups: TaskGroup[];
  activeId: number;
  origin: DropTarget;
  over: DropData;
  below?: boolean;
  sortLocked: boolean;
}): DropTarget | null {
  const { groups, activeId, origin, over, below = false, sortLocked } = args;
  const group = groups.find((g) => g.key === over.groupKey);
  if (!group) return null;
  const list = idsWithout(group, activeId);
  if (sortLocked) return group.key === origin.groupKey ? origin : { groupKey: group.key, index: list.length };
  switch (over.kind) {
    case 'row': {
      if (over.taskId === activeId) return origin;
      const i = list.indexOf(over.taskId ?? Number.NaN);
      if (i < 0) return null;
      return { groupKey: group.key, index: i + (below ? 1 : 0) };
    }
    case 'group':
      return { groupKey: group.key, index: over.collapsed ? list.length : 0 };
    case 'insert':
      return { groupKey: group.key, index: list.length };
  }
}

export type KeyboardSlot = DropTarget & { collapsed: boolean };

/**
 * 鍵盤拖曳的落點序列（↑↓ 依序移動）：展開的群組每個「列與列之間」各一個落點；
 * 收合的群組只有一個落點（標頭，放在尾端）；排序中每個群組只有一個落點。
 */
export function keyboardSlots(
  groups: TaskGroup[],
  activeId: number,
  origin: DropTarget,
  collapsedKeys: ReadonlySet<string>,
  sortLocked: boolean,
): KeyboardSlot[] {
  const out: KeyboardSlot[] = [];
  for (const g of groups) {
    const n = idsWithout(g, activeId).length;
    const collapsed = collapsedKeys.has(g.key) && g.key !== origin.groupKey;
    if (sortLocked) {
      out.push({ groupKey: g.key, index: g.key === origin.groupKey ? origin.index : n, collapsed });
    } else if (collapsed) {
      out.push({ groupKey: g.key, index: n, collapsed: true });
    } else {
      for (let i = 0; i <= n; i++) out.push({ groupKey: g.key, index: i, collapsed: false });
    }
  }
  return out;
}

/** 落點對應的 droppable id（供鍵盤拖曳的碰撞偵測與定位） */
export function slotDropId(
  slot: KeyboardSlot,
  groups: TaskGroup[],
  activeId: number,
  sortLocked: boolean,
): string {
  const g = groups.find((x) => x.key === slot.groupKey);
  const list = g ? idsWithout(g, activeId) : [];
  if (slot.collapsed) return dropId.group(slot.groupKey);
  if (sortLocked) return g?.mode === 'none' ? dropId.insert(slot.groupKey) : dropId.group(slot.groupKey);
  const next = list[slot.index];
  return next != null ? dropId.row(next) : dropId.insert(slot.groupKey);
}

/** 移到某群組時要改的欄位（依分組模式）；不分組 → 不改欄位 */
export function groupFieldPatch(mode: GroupMode, group: Pick<TaskGroup, 'id'>): TaskUpdateInput {
  switch (mode) {
    case 'status':
      return group.id != null ? { statusId: group.id } : {};
    case 'assignee':
      return { assigneeId: group.id };
    case 'project':
      return group.id != null ? { projectId: group.id } : {};
    case 'none':
      return {};
  }
}

export type DropPlan = {
  taskId: number;
  /** 被移動任務的分組欄位變更（跨群組時） */
  fields: TaskUpdateInput;
  /** 需寫入的 sort_order（被移動者 + 重新編號時的其他任務）；排序中為空 */
  sortPatches: SortPatch[];
  groupChanged: boolean;
};

/** 放下後要送出的變更；回原位或無效時回傳 null */
export function planDrop(args: {
  groups: TaskGroup[];
  mode: GroupMode;
  activeId: number;
  origin: DropTarget;
  target: DropTarget;
  sortLocked: boolean;
}): DropPlan | null {
  const { groups, mode, activeId, origin, target, sortLocked } = args;
  if (sameTarget(origin, target)) return null;
  const to = groups.find((g) => g.key === target.groupKey);
  const from = groups.find((g) => g.key === origin.groupKey);
  const active = from?.tasks.find((t) => t.id === activeId);
  if (!to || !active) return null;
  const groupChanged = to.key !== origin.groupKey;
  if (sortLocked && !groupChanged) return null;
  const fields = groupChanged ? groupFieldPatch(mode, to) : {};
  if (sortLocked) return { taskId: activeId, fields, sortPatches: [], groupChanged };
  const rest = to.tasks.filter((t) => t.id !== activeId);
  const index = Math.max(0, Math.min(target.index, rest.length));
  const ordered = [...rest.slice(0, index), active, ...rest.slice(index)].map((t) => ({
    id: t.id,
    sortOrder: t.sortOrder,
  }));
  return { taskId: activeId, fields, sortPatches: planSortOrders(ordered, index), groupChanged };
}

/** 畫面標記：哪一列上緣畫放置指示線、哪個群組高亮 */
export type DropMarker = { groupKey: string; beforeTaskId: number | null; atInsert: boolean };

export function markerFor(
  target: DropTarget | null,
  origin: DropTarget | null,
  groups: TaskGroup[],
  activeId: number,
  sortLocked: boolean,
): DropMarker | null {
  if (!target) return null;
  if (sameTarget(target, origin)) return { groupKey: target.groupKey, beforeTaskId: null, atInsert: false };
  if (sortLocked) return { groupKey: target.groupKey, beforeTaskId: null, atInsert: false };
  const g = groups.find((x) => x.key === target.groupKey);
  const list = g ? idsWithout(g, activeId) : [];
  const before = list[target.index];
  return { groupKey: target.groupKey, beforeTaskId: before ?? null, atInsert: before == null };
}

/** 即時播報文案（aria-live） */
export const announceDnd = {
  pickup: (title: string, group: string, n: number) => `已拿起『${title}』，目前在 ${group} 第 ${n} 筆`,
  move: (group: string, n: number | null) => (n == null ? `移到 ${group}` : `移到 ${group} 第 ${n} 筆`),
  drop: (group: string, n: number | null) => (n == null ? `已放到 ${group}` : `已放到 ${group} 第 ${n} 筆`),
  cancel: (group: string, n: number) => `已取消，回到 ${group} 第 ${n} 筆`,
  sortLocked: '排序中，無法手動調整順序',
};
