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
