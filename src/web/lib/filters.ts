/**
 * 任務篩選（FilterBar）與 URL 互轉。URL 參數：
 *   q=關鍵字、project=1,2、assignee=3,none（none = 未指派）、status=1,4
 * 解析時忽略格式錯誤的值，並去除重複、維持排序穩定，確保相同條件得到相同的查詢鍵。
 */

export type AssigneeFilter = number | 'none';

export type TaskFilters = {
  q: string;
  project: number[];
  assignee: AssigneeFilter[];
  status: number[];
};

export const FILTER_KEYS = ['q', 'project', 'assignee', 'status'] as const;

export const emptyFilters = (): TaskFilters => ({ q: '', project: [], assignee: [], status: [] });

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function parseAssignees(raw: string | null): AssigneeFilter[] {
  if (!raw) return [];
  const parts = raw.split(',').map((s) => s.trim());
  const ids = parseIds(parts.filter((p) => p !== 'none').join(','));
  return parts.includes('none') ? ['none', ...ids] : ids;
}

export function parseTaskFilters(sp: URLSearchParams): TaskFilters {
  return {
    q: (sp.get('q') ?? '').trim(),
    project: parseIds(sp.get('project')),
    assignee: parseAssignees(sp.get('assignee')),
    status: parseIds(sp.get('status')),
  };
}

/** 以 patch 更新篩選並寫回 URLSearchParams（保留其他參數，如 ?task=） */
export function writeTaskFilters(sp: URLSearchParams, patch: Partial<TaskFilters>): URLSearchParams {
  const next = new URLSearchParams(sp);
  const merged = { ...parseTaskFilters(sp), ...patch };
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set('q', merged.q.trim());
  set('project', normalize(merged.project).join(','));
  set('assignee', normalizeAssignees(merged.assignee).join(','));
  set('status', normalize(merged.status).join(','));
  return next;
}

/** 清除全部篩選（保留其他參數） */
export function clearTaskFilters(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const k of FILTER_KEYS) next.delete(k);
  return next;
}

export function hasActiveFilters(f: TaskFilters): boolean {
  return !!f.q || f.project.length > 0 || f.assignee.length > 0 || f.status.length > 0;
}

/** 轉為 GET /api/tasks 的 query string（含前導 ?；無條件時為空字串） */
export function toTaskQueryString(f: TaskFilters): string {
  const sp = new URLSearchParams();
  if (f.q) sp.set('q', f.q);
  if (f.project.length) sp.set('project', f.project.join(','));
  if (f.assignee.length) sp.set('assignee', f.assignee.join(','));
  if (f.status.length) sp.set('status', f.status.join(','));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function normalize(ids: number[]): number[] {
  return [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

function normalizeAssignees(list: AssigneeFilter[]): AssigneeFilter[] {
  const ids = normalize(list.filter((v): v is number => v !== 'none'));
  return list.includes('none') ? ['none', ...ids] : ids;
}

/** 多選切換：有則移除、無則加入 */
export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
