import { blockedBadgeText, blocksTooltip } from './depText.js';
import { useShowDependencyMarks } from './prefs.js';

/** 依賴欄位由 GET /api/tasks 附帶；舊快取或樂觀更新中的暫存任務可能沒有，一律視為無依賴 */

export function depFields(task) {
  return {
    isBlocked: task.isBlocked === true,
    blockedByCount: task.blockedByCount ?? 0,
    blocksCount: task.blocksCount ?? 0,
    delayDays: task.delayDays ?? null,
    projectedEnd: task.projectedEnd ?? null,
  };
}

/** 看板卡片根元素要加的 class（顯示開關關閉時為空） */
export function useDependencyCardClass(task, isDone = false) {
  const show = useShowDependencyMarks();
  return show && !isDone && depFields(task).isBlocked ? 'dep-card--blocked' : '';
}

/** 卡片 aria-label 的補充說明 */
export function dependencyAriaSuffix(task) {
  const d = depFields(task);
  const parts = [];
  if (d.isBlocked) parts.push(blockedBadgeText(d));
  if (d.blocksCount > 0) parts.push(blocksTooltip(d.blocksCount));
  return parts.length ? `，${parts.join('，')}` : '';
}
