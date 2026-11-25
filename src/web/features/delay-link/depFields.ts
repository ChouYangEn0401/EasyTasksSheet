import type { TaskDependencyFields } from '../../../shared/dependencies.ts';
import type { Task } from '../../../shared/tasks.ts';
import { blockedBadgeText, blocksTooltip } from './depText.ts';
import { useShowDependencyMarks } from './prefs.ts';

/** 依賴欄位由 GET /api/tasks 附帶；舊快取或樂觀更新中的暫存任務可能沒有，一律視為無依賴 */
export type Depish = Partial<TaskDependencyFields> & Pick<Task, 'dueDate'>;

export function depFields(task: Depish): TaskDependencyFields {
  return {
    isBlocked: task.isBlocked === true,
    blockedByCount: task.blockedByCount ?? 0,
    blocksCount: task.blocksCount ?? 0,
    delayDays: task.delayDays ?? null,
    projectedEnd: task.projectedEnd ?? null,
  };
}

/** 看板卡片根元素要加的 class（顯示開關關閉時為空） */
export function useDependencyCardClass(task: Depish, isDone = false): string {
  const show = useShowDependencyMarks();
  return show && !isDone && depFields(task).isBlocked ? 'dep-card--blocked' : '';
}

/** 卡片 aria-label 的補充說明 */
export function dependencyAriaSuffix(task: Depish): string {
  const d = depFields(task);
  const parts: string[] = [];
  if (d.isBlocked) parts.push(blockedBadgeText(d));
  if (d.blocksCount > 0) parts.push(blocksTooltip(d.blocksCount));
  return parts.length ? `，${parts.join('，')}` : '';
}
