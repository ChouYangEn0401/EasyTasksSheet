import { useProjectsById, useStatusesById, useUsersById } from '../../lib/hooks.js';
import { getValue, isEmptyValue, PRIORITY_LABELS } from './model.js';

/** 文字類（在容器內就地顯示 Input） */
export const TEXT_KINDS = new Set(['title', 'text', 'number', 'estimate', 'url']);
/** 無編輯模式，點擊即切換 */
export const TOGGLE_KINDS = new Set(['checkbox']);

/** 給螢幕閱讀器的值文字 */
export function useValueText(task, col) {
  const users = useUsersById();
  const projects = useProjectsById();
  const statuses = useStatusesById();
  const v = getValue(task, col);
  if (isEmptyValue(v)) return col.kind === 'assignee' ? '未指派' : '空白';
  switch (col.kind) {
    case 'status':
      return statuses.get(v)?.name ?? '';
    case 'assignee':
    case 'person':
      return users.get(v)?.displayName ?? '';
    case 'project':
      return projects.get(v)?.name ?? '';
    case 'priority':
      return PRIORITY_LABELS[task.priority];
    case 'checkbox':
      return v ? '已勾選' : '未勾選';
    case 'select':
      return col.property?.options.find((o) => o.id === v)?.label ?? '';
    case 'multi_select':
      return v
        .map((id) => col.property?.options.find((o) => o.id === id)?.label)
        .filter(Boolean)
        .join('、');
    case 'updatedAt':
      return new Date(task.updatedAt).toLocaleString();
    default:
      return String(v);
  }
}
