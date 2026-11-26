/**
 * 清單拖曳（docs/design/task-list.md §13）的純函式：放置目標、鍵盤落點、欄位 patch 與 sort_order 計算。
 * 不依賴 React / DOM，方便單元測試（listDndModel.test.ts）。
 * sort_order 的前後取中值 / 重新編號沿用看板的 planSortOrders（只匯入、不修改 kanban）。
 */

import { planSortOrders } from '../kanban/kanbanModel.js';

/** droppable 種類：任務列、群組標頭列、群組底部「新增任務」列 */

/** 放置位置：群組 + 在「移除被拖曳任務後」的群組清單中的插入索引 */

export const dragId = (taskId) => `dnd-task:${taskId}`;
export const dropId = {
  row: (taskId) => `dnd-row:${taskId}`,
  group: (groupKey) => `dnd-group:${groupKey}`,
  insert: (groupKey) => `dnd-insert:${groupKey}`,
};

export function parseDragId(id) {
  if (typeof id !== 'string' || !id.startsWith('dnd-task:')) return null;
  const n = Number(id.slice(9));
  return Number.isInteger(n) ? n : null;
}

/** 群組內（排除被拖曳任務）的任務 id */
export function idsWithout(group, activeId) {
  return group.tasks.filter((t) => t.id !== activeId).map((t) => t.id);
}

/** 被拖曳任務的原位置 */
export function originOf(groups, activeId) {
  for (const g of groups) {
    const i = g.tasks.findIndex((t) => t.id === activeId);
    if (i >= 0) return { groupKey: g.key, index: i };
  }
  return null;
}

export const sameTarget = (a, b) => !!a && !!b && a.groupKey === b.groupKey && a.index === b.index;

/**
 * 指標經過的 droppable → 放置位置。
 * - 任務列：依指標在列的上半 / 下半決定插在該列之前 / 之後（below）。
 * - 群組標頭：展開中 → 群組最前；收合中 → 群組最後（列看不到，加在尾端）。
 * - 「新增任務」列（含空群組唯一的列）：群組最後。
 * - 排序中（sortLocked）：群組內順序由排序決定 → 同群組一律回原位；跨群組只決定群組（放在尾端）。
 */
export function resolveTarget(args) {
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

/**
 * 鍵盤拖曳的落點序列（↑↓ 依序移動）：展開的群組每個「列與列之間」各一個落點；
 * 收合的群組只有一個落點（標頭，放在尾端）；排序中每個群組只有一個落點。
 */
export function keyboardSlots(groups, activeId, origin, collapsedKeys, sortLocked) {
  const out = [];
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
export function slotDropId(slot, groups, activeId, sortLocked) {
  const g = groups.find((x) => x.key === slot.groupKey);
  const list = g ? idsWithout(g, activeId) : [];
  if (slot.collapsed) return dropId.group(slot.groupKey);
  if (sortLocked) return g?.mode === 'none' ? dropId.insert(slot.groupKey) : dropId.group(slot.groupKey);
  const next = list[slot.index];
  return next != null ? dropId.row(next) : dropId.insert(slot.groupKey);
}

/** 移到某群組時要改的欄位（依分組模式）；不分組 → 不改欄位 */
export function groupFieldPatch(mode, group) {
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

/** 放下後要送出的變更；回原位或無效時回傳 null */
export function planDrop(args) {
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

export function markerFor(target, origin, groups, activeId, sortLocked) {
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
  pickup: (title, group, n) => `已拿起『${title}』，目前在 ${group} 第 ${n} 筆`,
  move: (group, n) => (n == null ? `移到 ${group}` : `移到 ${group} 第 ${n} 筆`),
  drop: (group, n) => (n == null ? `已放到 ${group}` : `已放到 ${group} 第 ${n} 筆`),
  cancel: (group, n) => `已取消，回到 ${group} 第 ${n} 筆`,
  sortLocked: '排序中，無法手動調整順序',
};
