import { deriveFeedbackStatus, FEEDBACK_KINDS, FEEDBACK_STATUSES } from '../../shared/feedback.js';

/** 頁面篩選（存於 URL：kind、status 逗號分隔、month=YYYY-MM） */

export function readFilters(sp) {
  const kind = sp.get('kind');
  const status = (sp.get('status') ?? '').split(',').filter((s) => FEEDBACK_STATUSES.includes(s));
  return {
    kind: FEEDBACK_KINDS.includes(kind ?? '') ? kind : null,
    status: [...new Set(status)],
  };
}

/** 把篩選寫回 URLSearchParams（保留其他參數，如 month、task） */
export function writeFilters(sp, filters) {
  const next = new URLSearchParams(sp);
  if (filters.kind) next.set('kind', filters.kind);
  else next.delete('kind');
  if (filters.status.length) next.set('status', filters.status.join(','));
  else next.delete('status');
  return next;
}

export const hasFilters = (f) => f.kind != null || f.status.length > 0;

export function applyFilters(items, f) {
  return items.filter(
    (i) => (f.kind == null || i.kind === f.kind) && (f.status.length === 0 || f.status.includes(i.status)),
  );
}

/** 依狀態分群並排序：未排程（建立新→舊）、已排程（排程日近→遠）、已解決（更新新→舊） */
export function groupItems(items) {
  const groups = { open: [], scheduled: [], resolved: [] };
  for (const item of items) groups[item.status].push(item);
  groups.open.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  groups.scheduled.sort(
    (a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') || a.id - b.id,
  );
  groups.resolved.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  return groups;
}

/** 依排程日分組（月曆用），同日依類型、建立時間排序 */
export function itemsByDate(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.scheduledDate) continue;
    const list = map.get(item.scheduledDate) ?? [];
    list.push(item);
    map.set(item.scheduledDate, list);
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        Number(a.status === 'resolved') - Number(b.status === 'resolved') || a.createdAt - b.createdAt,
    );
  }
  return map;
}

/** 樂觀更新：在前端套用 PATCH 並以與後端相同規則推導狀態 */
export function applyPatch(item, patch, now = Date.now()) {
  const { resolved, ...fields } = patch;
  const next = { ...item, ...fields, updatedAt: now };
  const isResolved = resolved ?? item.status === 'resolved';
  next.status = deriveFeedbackStatus(isResolved, next.scheduledDate);
  return next;
}
