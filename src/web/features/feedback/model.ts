import {
  deriveFeedbackStatus,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
  type FeedbackUpdateInput,
} from '../../../shared/feedback.ts';

/** 頁面篩選（存於 URL：kind、status 逗號分隔、month=YYYY-MM） */
export type FeedbackFilters = {
  kind: FeedbackKind | null;
  status: FeedbackStatus[];
};

export function readFilters(sp: URLSearchParams): FeedbackFilters {
  const kind = sp.get('kind');
  const status = (sp.get('status') ?? '')
    .split(',')
    .filter((s): s is FeedbackStatus => (FEEDBACK_STATUSES as readonly string[]).includes(s));
  return {
    kind: (FEEDBACK_KINDS as readonly string[]).includes(kind ?? '') ? (kind as FeedbackKind) : null,
    status: [...new Set(status)],
  };
}

/** 把篩選寫回 URLSearchParams（保留其他參數，如 month、task） */
export function writeFilters(sp: URLSearchParams, filters: FeedbackFilters): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (filters.kind) next.set('kind', filters.kind);
  else next.delete('kind');
  if (filters.status.length) next.set('status', filters.status.join(','));
  else next.delete('status');
  return next;
}

export const hasFilters = (f: FeedbackFilters) => f.kind != null || f.status.length > 0;

export function applyFilters(items: FeedbackItem[], f: FeedbackFilters): FeedbackItem[] {
  return items.filter(
    (i) => (f.kind == null || i.kind === f.kind) && (f.status.length === 0 || f.status.includes(i.status)),
  );
}

export type FeedbackGroups = Record<FeedbackStatus, FeedbackItem[]>;

/** 依狀態分群並排序：未排程（建立新→舊）、已排程（排程日近→遠）、已解決（更新新→舊） */
export function groupItems(items: FeedbackItem[]): FeedbackGroups {
  const groups: FeedbackGroups = { open: [], scheduled: [], resolved: [] };
  for (const item of items) groups[item.status].push(item);
  groups.open.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  groups.scheduled.sort(
    (a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') || a.id - b.id,
  );
  groups.resolved.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  return groups;
}

/** 依排程日分組（月曆用），同日依類型、建立時間排序 */
export function itemsByDate(items: FeedbackItem[]): Map<string, FeedbackItem[]> {
  const map = new Map<string, FeedbackItem[]>();
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
export function applyPatch(item: FeedbackItem, patch: FeedbackUpdateInput, now = Date.now()): FeedbackItem {
  const { resolved, ...fields } = patch;
  const next = { ...item, ...fields, updatedAt: now } as FeedbackItem;
  const isResolved = resolved ?? item.status === 'resolved';
  next.status = deriveFeedbackStatus(isResolved, next.scheduledDate);
  return next;
}
