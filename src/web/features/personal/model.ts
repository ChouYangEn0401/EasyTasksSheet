import type { PersonalItem, PersonalStatus } from '../../../shared/personal.ts';
import type { Status } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import { todayString } from '../../lib/format.ts';

/** 任務是否已完成（狀態 category = done） */
export const isDoneTask = (task: Task, statuses: Map<number, Status>) =>
  statuses.get(task.statusId)?.category === 'done';

/** 依到期日近→遠，無日期排最後；同日依 id */
function byDue(a: Task, b: Task): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.id - b.id;
}

/**
 * 「指派給我」的列：預設只列未完成（到期日近→遠，無日期排最後）；
 * showDone 時已完成接在最後（最近更新者在前）。
 */
export function assignedRows(
  tasks: readonly Task[],
  statuses: Map<number, Status>,
  showDone: boolean,
): Task[] {
  const open = tasks.filter((t) => !isDoneTask(t, statuses)).sort(byDue);
  if (!showDone) return open;
  const done = tasks.filter((t) => isDoneTask(t, statuses)).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...open, ...done];
}

/** 到期日顯示：同年 MM/DD、跨年 YYYY/MM/DD、無則「—」；逾期只對未完成標示 */
export function dueLabel(
  due: string | null,
  done: boolean,
  now: number = Date.now(),
): { text: string; overdue: boolean } {
  if (!due) return { text: '—', overdue: false };
  const today = todayString(now);
  const [y, m, d] = due.split('-');
  const text = y === today.slice(0, 4) ? `${m}/${d}` : `${y}/${m}/${d}`;
  return { text, overdue: !done && due < today };
}

/** 區塊標題 / 空狀態文案（檢視他人時把「你 / 我」換成成員名稱） */
export function sectionText(name: string | null) {
  return name == null
    ? {
        assigned: '指派給我的任務',
        pinned: '我標記的任務',
        todos: '自由待辦',
        assignedEmpty: '目前沒有指派給你的任務',
        pinnedEmpty: '還沒有標記的任務',
        todosEmpty: '寫下第一件待辦',
      }
    : {
        assigned: `指派給 ${name} 的任務`,
        pinned: `${name} 標記的任務`,
        todos: `${name} 的自由待辦`,
        assignedEmpty: `目前沒有指派給 ${name} 的任務`,
        pinnedEmpty: `${name} 還沒有標記的任務`,
        todosEmpty: `${name} 還沒有自由待辦`,
      };
}

/** 排序播報文案 */
export const announce = {
  pickup: (title: string, n: number, m: number) => `已拿起 ${title}，位置 ${n} / ${m}`,
  move: (n: number) => `已移到位置 ${n}`,
  drop: (n: number) => `已放到位置 ${n}`,
  cancel: () => '已取消',
};

/* ── 自由待辦的小狀態 ─────────────────────── */

/** 狀態 chip 的色調（只用 Badge 的語意色）：延後 = 黃、進行中 = 藍、完成 = 綠、其餘灰 */
export const STATUS_TONE: Record<PersonalStatus, 'neutral' | 'accent' | 'success' | 'warning'> = {
  todo: 'neutral',
  doing: 'accent',
  deferred: 'warning',
  cancelled: 'neutral',
  done: 'success',
};

export type StatusFilter = 'all' | 'doing' | 'deferred' | 'cancelled' | 'done';
export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'doing', label: '進行中' },
  { value: 'deferred', label: '延後' },
  { value: 'cancelled', label: '取消' },
  { value: 'done', label: '已完成' },
];

/** 延後 / 取消：沉到清單後面的「暫緩」群組 */
export const isParked = (i: PersonalItem) => i.status === 'deferred' || i.status === 'cancelled';

/**
 * 「全部」檢視的分組（保持 sortOrder 順序）：
 * active = 待處理 + 進行中（可拖曳排序）、parked = 延後 + 取消（沉到後面）、done = 完成（預設收合）
 */
export function groupTodos(items: readonly PersonalItem[]) {
  return {
    active: items.filter((i) => i.status === 'todo' || i.status === 'doing'),
    parked: items.filter(isParked),
    done: items.filter((i) => i.status === 'done'),
  };
}

/** 單一狀態篩選（all 回傳全部） */
export function filterTodos(items: readonly PersonalItem[], filter: StatusFilter): PersonalItem[] {
  return filter === 'all' ? [...items] : items.filter((i) => i.status === filter);
}

/** 各篩選鈕上的數量 */
export function filterCounts(items: readonly PersonalItem[]): Record<StatusFilter, number> {
  const count = (st: PersonalStatus) => items.filter((i) => i.status === st).length;
  return {
    all: items.length,
    doing: count('doing'),
    deferred: count('deferred'),
    cancelled: count('cancelled'),
    done: count('done'),
  };
}

/** `?todo=<id>`：目前開啟 inspector 的待辦 id */
export function readTodoParam(sp: URLSearchParams): number | null {
  const raw = sp.get('todo');
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}
