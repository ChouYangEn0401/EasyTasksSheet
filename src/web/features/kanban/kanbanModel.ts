/**
 * Kanban 純函式（docs/design/task-kanban.md）：分欄、sort_order 計算、鍵盤導覽、篩選比對與顯示格式。
 * 不依賴 React / DOM，方便單元測試。
 */
import type { Status } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import type { TaskFilters } from '../../lib/filters.ts';
import { todayString } from '../../lib/format.ts';

/** 每欄先渲染的卡片數，其後以「顯示其餘 N 筆」展開 */
export const COLUMN_PAGE_SIZE = 50;

/** 欄（droppable）的 id；卡片（sortable）的 id 直接用任務 id（number） */
export const columnId = (statusId: number) => `col-${statusId}`;

export function parseColumnId(id: string | number | null | undefined): number | null {
  if (typeof id !== 'string' || !id.startsWith('col-')) return null;
  const n = Number(id.slice(4));
  return Number.isInteger(n) ? n : null;
}

/** 與後端相同的排序：sortOrder，再以 id 決勝 */
export const compareTasks = (a: Pick<Task, 'id' | 'sortOrder'>, b: Pick<Task, 'id' | 'sortOrder'>) =>
  a.sortOrder - b.sortOrder || a.id - b.id;

/** 依 FilterBar 的狀態篩選決定要渲染的欄（statuses 已依 sortOrder 排序） */
export function visibleStatuses<S extends Pick<Status, 'id'>>(statuses: S[], filters: TaskFilters): S[] {
  if (!filters.status.length) return statuses;
  return statuses.filter((s) => filters.status.includes(s.id));
}

/** 任務分欄：statusId → 任務 id 陣列（已排序）；不在 statusIds 內的任務略過 */
export function groupTaskIds(tasks: Task[], statusIds: number[]): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const id of statusIds) out[id] = [];
  for (const t of [...tasks].sort(compareTasks)) out[t.statusId]?.push(t.id);
  return out;
}

/** 卡片所在欄 */
export function findColumn(columns: Record<number, number[]>, taskId: number): number | null {
  for (const [statusId, ids] of Object.entries(columns)) if (ids.includes(taskId)) return Number(statusId);
  return null;
}

/** 把卡片從 from 欄移到 to 欄的 index（index 以 to 欄「移除自身後」計） */
export function moveToColumn(
  columns: Record<number, number[]>,
  taskId: number,
  from: number,
  to: number,
  index: number,
): Record<number, number[]> {
  const src = (columns[from] ?? []).filter((id) => id !== taskId);
  const base = from === to ? src : (columns[to] ?? []).filter((id) => id !== taskId);
  const i = Math.max(0, Math.min(index, base.length));
  const dst = [...base.slice(0, i), taskId, ...base.slice(i)];
  return { ...columns, [from]: from === to ? dst : src, [to]: dst };
}

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export type SortPatch = { id: number; sortOrder: number };

/**
 * 放下後要寫入的 sort_order。ordered 為落點欄「放下後」的順序（含被移動的卡片於 index）。
 * 一般只回傳被移動卡片一筆：前後中間值；欄首 = 首張 − 1、欄尾 = 末張 + 1、空欄 = 0。
 * 前後鄰居同值（或浮點已無法再切分）時改為整欄重新編號，回傳所有需變更的卡片（被移動者必在其中）。
 */
export function planSortOrders(ordered: SortPatch[], index: number): SortPatch[] {
  const moved = ordered[index];
  if (!moved) return [];
  const prev = ordered[index - 1];
  const next = ordered[index + 1];
  if (!prev && !next) return [{ id: moved.id, sortOrder: 0 }];
  if (!prev) return [{ id: moved.id, sortOrder: next!.sortOrder - 1 }];
  if (!next) return [{ id: moved.id, sortOrder: prev.sortOrder + 1 }];
  const mid = (prev.sortOrder + next.sortOrder) / 2;
  if (prev.sortOrder < mid && mid < next.sortOrder) return [{ id: moved.id, sortOrder: mid }];
  // 重新編號：保留首張的值為起點，每張 +1
  const start = Math.floor(ordered[0]!.sortOrder);
  const patches: SortPatch[] = [];
  ordered.forEach((t, i) => {
    const sortOrder = start + i;
    if (t.id === moved.id || t.sortOrder !== sortOrder) patches.push({ id: t.id, sortOrder });
  });
  return patches;
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
export const NAV_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

/**
 * 瀏覽模式的鍵盤導覽：cols 為各可見欄的卡片 id（由左至右），回傳目標卡片 id（無則 null）。
 * ←/→ 移到相鄰欄中位置最接近的卡片，空欄跳過。
 */
export function navTarget(cols: number[][], currentId: number, key: NavKey): number | null {
  const c = cols.findIndex((ids) => ids.includes(currentId));
  if (c < 0) return null;
  const col = cols[c]!;
  const i = col.indexOf(currentId);
  switch (key) {
    case 'ArrowUp':
      return col[i - 1] ?? null;
    case 'ArrowDown':
      return col[i + 1] ?? null;
    case 'Home':
      return col[0] ?? null;
    case 'End':
      return col[col.length - 1] ?? null;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const step = key === 'ArrowLeft' ? -1 : 1;
      for (let j = c + step; j >= 0 && j < cols.length; j += step) {
        const other = cols[j]!;
        if (other.length) return other[Math.min(i, other.length - 1)]!;
      }
      return null;
    }
  }
}

/** 新任務是否符合目前篩選（不符合時欄尾提示「已建立，但不符合目前篩選」） */
export function matchesFilters(task: Task, f: TaskFilters): boolean {
  if (f.q && !task.title.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.project.length && !f.project.includes(task.projectId)) return false;
  if (f.status.length && !f.status.includes(task.statusId)) return false;
  if (f.assignee.length) {
    const ok = task.assigneeId == null ? f.assignee.includes('none') : f.assignee.includes(task.assigneeId);
    if (!ok) return false;
  }
  return true;
}

/** 欄尾 QuickAdd 的 defaults：該欄狀態、篩選恰好單選的專案 / 負責人、排在欄底 */
export function quickAddDefaults(
  statusId: number,
  filters: TaskFilters,
  lastSortOrder: number | null,
): { statusId: number; sortOrder: number; projectId?: number; assigneeId?: number } {
  const out: { statusId: number; sortOrder: number; projectId?: number; assigneeId?: number } = {
    statusId,
    sortOrder: lastSortOrder == null ? 0 : lastSortOrder + 1,
  };
  if (filters.project.length === 1) out.projectId = filters.project[0]!;
  const a = filters.assignee;
  if (a.length === 1 && typeof a[0] === 'number') out.assigneeId = a[0];
  return out;
}

/** 預估工時：6h、1.5h（小數最多一位） */
export const formatHours = (h: number) => `${Math.round(h * 10) / 10}h`;

/** 欄的預估工時合計 */
export const sumHours = (tasks: Pick<Task, 'estimateHours'>[]) =>
  tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0);

export type DueDisplay = { text: string; tone: 'normal' | 'overdue' | 'today' };

/** 到期日：MM/DD（跨年 YYYY/MM/DD）；逾期 / 今天（done 類欄一律一般色） */
export function dueDisplay(due: string | null, isDone: boolean, now: number = Date.now()): DueDisplay | null {
  if (!due) return null;
  const today = todayString(now);
  const [y, m, d] = due.split('-');
  if (!isDone && due === today) return { text: '今天', tone: 'today' };
  const text = y === today.slice(0, 4) ? `${m}/${d}` : `${y}/${m}/${d}`;
  return { text, tone: !isDone && due < today ? 'overdue' : 'normal' };
}

/** 卡片 aria-label：「<標題>，負責人 <姓名或未指派>，到期 <日期或無>，預估 <N 小時或未估>」 */
export function cardAriaLabel(task: Task, assigneeName: string | null | undefined): string {
  const due = task.dueDate ? task.dueDate.replaceAll('-', '/') : '無';
  const est = task.estimateHours != null ? `${Math.round(task.estimateHours * 10) / 10} 小時` : '未估';
  return `${task.title}，負責人 ${assigneeName ?? '未指派'}，到期 ${due}，預估 ${est}`;
}

/** 即時播報文案 */
export const announce = {
  pickup: (title: string, column: string, n: number, m: number) =>
    `已拿起『${title}』，目前在 ${column} 第 ${n} 張，共 ${m} 張`,
  move: (column: string, n: number) => `移到 ${column} 第 ${n} 張`,
  drop: (column: string, n: number) => `已放到 ${column} 第 ${n} 張`,
  cancel: (column: string, n: number) => `已取消，回到 ${column} 第 ${n} 張`,
};
