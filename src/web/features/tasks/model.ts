/**
 * T1 List / Drawer 的純邏輯（欄位定義、排序、分組、輸入驗證、篩選比對）。
 * 不依賴 React，方便單元測試（model.test.ts）。
 */
import type { Project, Status } from '../../../shared/projects.ts';
import type { PropertyDef, PropertyType, SelectOption } from '../../../shared/properties.ts';
import { TAG_COLORS, type TagColor } from '../../../shared/projects.ts';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type Task,
  type TaskPriority,
  type TaskUpdateInput,
} from '../../../shared/tasks.ts';
import type { PublicUser } from '../../../shared/users.ts';
import type { TaskFilters } from '../../lib/filters.ts';

// ── 欄位 ─────────────────────────────────────────

export type FieldKind =
  | 'title'
  | 'status'
  | 'assignee'
  | 'project'
  | 'priority'
  | 'startDate'
  | 'dueDate'
  | 'estimate'
  | 'progress'
  | 'updatedAt'
  | PropertyType;

export type ColumnDef = {
  /** 欄位鍵：內建為名稱，自訂為 p<id> */
  key: string;
  label: string;
  kind: FieldKind;
  /** 自訂欄位的定義 */
  property?: PropertyDef;
  /** CSS grid 欄寬 */
  width: string;
  /** 可否隱藏（標題不可） */
  hideable: boolean;
  /** 可否排序 */
  sortable: boolean;
};

export const TITLE_MAX = 500;
export const ESTIMATE_STEP = 0.5;

const W = { check: 40, status: 128, person: 144, date: 104, estimate: 80, custom: 144, updated: 96, add: 40 };

export const BUILTIN_COLUMNS: ColumnDef[] = [
  {
    key: 'title',
    label: '標題',
    kind: 'title',
    width: 'minmax(var(--tl-title-min), 1fr)',
    hideable: false,
    sortable: true,
  },
  { key: 'status', label: '狀態', kind: 'status', width: `${W.status}px`, hideable: true, sortable: true },
  {
    key: 'assignee',
    label: '負責人',
    kind: 'assignee',
    width: `${W.person}px`,
    hideable: true,
    sortable: true,
  },
  {
    key: 'startDate',
    label: '開始日',
    kind: 'startDate',
    width: `${W.date}px`,
    hideable: true,
    sortable: true,
  },
  { key: 'dueDate', label: '到期日', kind: 'dueDate', width: `${W.date}px`, hideable: true, sortable: true },
  {
    key: 'estimateHours',
    label: '工時',
    kind: 'estimate',
    width: `${W.estimate}px`,
    hideable: true,
    sortable: true,
  },
];
export const UPDATED_COLUMN: ColumnDef = {
  key: 'updatedAt',
  label: '更新',
  kind: 'updatedAt',
  width: `${W.updated}px`,
  hideable: true,
  sortable: true,
};

export const propertyKey = (id: number) => `p${id}`;

export function propertyColumn(p: PropertyDef): ColumnDef {
  return {
    key: propertyKey(p.id),
    label: p.name,
    kind: p.type,
    property: p,
    width: `${W.custom}px`,
    hideable: true,
    sortable: true,
  };
}

/** 全部欄位：內建 → 自訂（依 sortOrder）→ 更新 */
export function allColumns(properties: PropertyDef[]): ColumnDef[] {
  const custom = [...properties].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).map(propertyColumn);
  return [...BUILTIN_COLUMNS, ...custom, UPDATED_COLUMN];
}

/** 隱藏清單（localStorage 存「隱藏」的鍵，新欄位預設顯示） */
export function parseHidden(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== 'title') : [];
  } catch {
    return [];
  }
}

export function visibleColumns(columns: ColumnDef[], hidden: string[]): ColumnDef[] {
  return columns.filter((c) => !c.hideable || !hidden.includes(c.key));
}

/** grid-template-columns：完成鈕 + 欄位 + 「+」 */
export function gridTemplate(columns: ColumnDef[]): string {
  return [`${W.check}px`, ...columns.map((c) => c.width), `${W.add}px`].join(' ');
}

/** 表格最小寬（不含標題欄最小寬，標題以 CSS 變數另加） */
export function fixedWidth(columns: ColumnDef[]): number {
  return (
    W.check +
    W.add +
    columns.reduce((sum, c) => sum + (c.kind === 'title' ? 0 : Number.parseInt(c.width, 10) || 0), 0)
  );
}

/** 專案限定欄位遇到其他專案的任務 → 不適用 */
export function isApplicable(task: Pick<Task, 'projectId'>, col: ColumnDef): boolean {
  return !col.property || col.property.projectId == null || col.property.projectId === task.projectId;
}

/** 適用於某專案的自訂欄位（Drawer 用，依 sortOrder） */
export function applicableProperties(properties: PropertyDef[], projectId: number): PropertyDef[] {
  return properties
    .filter((p) => p.projectId == null || p.projectId === projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

// ── 讀值 / 寫入 ───────────────────────────────────

export function getValue(task: Task, col: Pick<ColumnDef, 'kind' | 'property'>): unknown {
  if (col.property) return task.custom[String(col.property.id)] ?? null;
  switch (col.kind) {
    case 'title':
      return task.title;
    case 'status':
      return task.statusId;
    case 'assignee':
      return task.assigneeId;
    case 'project':
      return task.projectId;
    case 'priority':
      return task.priority;
    case 'startDate':
      return task.startDate;
    case 'dueDate':
      return task.dueDate;
    case 'estimate':
      return task.estimateHours;
    case 'progress':
      return task.progress;
    case 'updatedAt':
      return task.updatedAt;
    default:
      return null;
  }
}

/** 欄位值 → PATCH 內容（只送該欄位） */
export function toPatch(col: Pick<ColumnDef, 'kind' | 'property'>, value: unknown): TaskUpdateInput {
  if (col.property) return { custom: { [String(col.property.id)]: isEmptyValue(value) ? null : value } };
  switch (col.kind) {
    case 'title':
      return { title: String(value) };
    case 'status':
      return { statusId: value as number };
    case 'assignee':
      return { assigneeId: (value as number | null) ?? null };
    case 'project':
      return { projectId: value as number };
    case 'priority':
      return { priority: value as TaskPriority };
    case 'startDate':
      return { startDate: (value as string | null) || null };
    case 'dueDate':
      return { dueDate: (value as string | null) || null };
    case 'estimate':
      return { estimateHours: (value as number | null) ?? null };
    case 'progress':
      return { progress: value as number };
    default:
      return {};
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** 樂觀更新：把 PATCH 套用到任務（custom 逐鍵合併，null 清除） */
export function applyPatch(task: Task, patch: TaskUpdateInput, now: number, userId?: number | null): Task {
  const { custom, ...fields } = patch;
  const next: Task = { ...task, ...(fields as Partial<Task>), updatedAt: now };
  if (userId != null) next.updatedBy = userId;
  if (custom) {
    const merged = { ...task.custom };
    for (const [k, v] of Object.entries(custom)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    next.custom = merged;
  }
  return next;
}

// ── 輸入驗證 ─────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseTitle(raw: string): Parsed<string> {
  const v = raw.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!v) return { ok: false, error: '標題不可空白' };
  if (v.length > TITLE_MAX) return { ok: false, error: `標題不可超過 ${TITLE_MAX} 字` };
  return { ok: true, value: v };
}

/** 數字輸入：空白 = 清除（null）；estimate 限 ≥ 0 且 0.5 級距 */
export function parseNumber(raw: string, opts: { estimate?: boolean } = {}): Parsed<number | null> {
  const s = raw.trim().replace(/,/g, '');
  if (!s) return { ok: true, value: null };
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, error: '請輸入數字' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: '請輸入數字' };
  if (opts.estimate) {
    if (n < 0) return { ok: false, error: '工時不可小於 0' };
    if (Math.round(n / ESTIMATE_STEP) * ESTIMATE_STEP !== n)
      return { ok: false, error: '工時以 0.5 小時為單位' };
  }
  return { ok: true, value: n };
}

export function parseUrl(raw: string): Parsed<string | null> {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    return { ok: true, value: s };
  } catch {
    return { ok: false, error: '請輸入有效網址' };
  }
}

/** 到期日不可早於開始日 */
export function checkDateRange(start: string | null, due: string | null): string | null {
  return start && due && due < start ? '到期日不可早於開始日' : null;
}

// ── 顯示 ─────────────────────────────────────────

/** YYYY-MM-DD → MM/DD；跨年 YYYY/MM/DD */
export function formatShortDate(date: string | null | undefined, now: number = Date.now()): string {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  return Number(y) === new Date(now).getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

export const PRIORITY_LABELS = TASK_PRIORITY_LABELS;
export const PRIORITY_TONES: Record<TaskPriority, 'neutral' | 'gray' | 'blue' | 'orange' | 'red'> = {
  none: 'neutral',
  low: 'gray',
  medium: 'blue',
  high: 'orange',
  urgent: 'red',
};
export const PRIORITY_ORDER = TASK_PRIORITIES;

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: '文字',
  number: '數字',
  select: '單選',
  multi_select: '多選',
  date: '日期',
  checkbox: '核取方塊',
  url: '網址',
  person: '成員',
};

/** 新選項依序輪替顏色 */
export function nextOptionColor(index: number): TagColor {
  return TAG_COLORS[(index + 1) % TAG_COLORS.length]!;
}

/** 產生不重複的選項 id */
export function newOptionId(existing: Pick<SelectOption, 'id'>[]): string {
  let n = existing.length + 1;
  const ids = new Set(existing.map((o) => o.id));
  while (ids.has(`o${n}`)) n++;
  return `o${n}`;
}

/** 欄位名稱檢查：空白 / 重複 */
export function checkPropertyName(name: string, others: { id?: number; name: string }[], selfId?: number) {
  const v = name.trim();
  if (!v) return '請輸入名稱';
  const builtins = [...BUILTIN_COLUMNS, UPDATED_COLUMN].map((c) => c.label);
  if (builtins.includes(v) || others.some((o) => o.id !== selfId && o.name.trim() === v))
    return '已有同名欄位';
  return null;
}

/** 選項合法：至少一個非空、不重複 */
export function checkOptions(options: { label: string }[]): string | null {
  const labels = options.map((o) => o.label.trim()).filter(Boolean);
  if (labels.length === 0) return '至少需要一個選項';
  if (new Set(labels).size !== labels.length) return '選項名稱不可重複';
  return null;
}

/** 有多少任務使用某選項（編輯選項時警示） */
export function countOptionUsage(tasks: Task[], propertyId: number, optionId: string): number {
  const key = String(propertyId);
  return tasks.filter((t) => {
    const v = t.custom[key];
    return Array.isArray(v) ? v.includes(optionId) : v === optionId;
  }).length;
}

// ── 排序 ─────────────────────────────────────────

export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;

export type Lookups = {
  statuses: Map<number, Status>;
  users: Map<number, Pick<PublicUser, 'id' | 'displayName'>>;
  projects: Map<number, Project>;
};

/** 排序用的比較值；null = 空值（恆排最後） */
export function sortValue(task: Task, col: ColumnDef, lk: Lookups): string | number | null {
  const v = getValue(task, col);
  if (isEmptyValue(v)) return null;
  switch (col.kind) {
    case 'title':
    case 'text':
    case 'url':
      return String(v).toLocaleLowerCase();
    case 'status':
      return lk.statuses.get(v as number)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    case 'assignee':
    case 'person':
      return lk.users.get(v as number)?.displayName ?? '';
    case 'project':
      return lk.projects.get(v as number)?.sortOrder ?? 0;
    case 'priority':
      return PRIORITY_ORDER.indexOf(v as TaskPriority);
    case 'checkbox':
      return v ? 1 : 0;
    case 'select': {
      const opts = col.property?.options ?? [];
      const i = opts.findIndex((o) => o.id === v);
      return i < 0 ? null : i;
    }
    case 'multi_select': {
      const opts = col.property?.options ?? [];
      const labels = (v as string[]).map((id) => opts.find((o) => o.id === id)?.label ?? '').join(',');
      return labels || null;
    }
    default:
      return typeof v === 'number' ? v : String(v);
  }
}

const collator = new Intl.Collator('zh-Hant', { numeric: true });

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** 依欄位排序（空值恆排最後，同值依原順序）；sort 為 null 時依 sortOrder */
export function sortTasks(tasks: Task[], sort: SortState, columns: ColumnDef[], lk: Lookups): Task[] {
  const base = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const col = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !col) return base;
  const keyed = base.map((t, i) => ({ t, i, v: sortValue(t, col, lk) }));
  keyed.sort((x, y) => {
    if (x.v === null && y.v === null) return x.i - y.i;
    if (x.v === null) return 1;
    if (y.v === null) return -1;
    const c = compareValues(x.v, y.v);
    return (sort.dir === 'asc' ? c : -c) || x.i - y.i;
  });
  return keyed.map((k) => k.t);
}

export function parseSort(sp: URLSearchParams): SortState {
  const key = sp.get('sort');
  if (!key) return null;
  return { key, dir: sp.get('dir') === 'desc' ? 'desc' : 'asc' };
}

/** 點欄名循環：升冪 → 降冪 → 取消 */
export function cycleSort(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

// ── 分組 ─────────────────────────────────────────

export type GroupMode = 'status' | 'assignee' | 'project' | 'none';
export const GROUP_MODES: { value: GroupMode; label: string }[] = [
  { value: 'status', label: '狀態' },
  { value: 'assignee', label: '負責人' },
  { value: 'project', label: '專案' },
  { value: 'none', label: '不分組' },
];

export function parseGroup(sp: URLSearchParams): GroupMode {
  const g = sp.get('group');
  return g === 'assignee' || g === 'project' || g === 'none' ? g : 'status';
}

export type TaskGroup = {
  /** 群組鍵（status:1、assignee:none…） */
  key: string;
  mode: GroupMode;
  /** 群組對應的 id（status / user / project；未指派為 null） */
  id: number | null;
  tasks: Task[];
};

/** 依模式分組；tasks 應已排序（排序在群組內保持） */
export function groupTasks(tasks: Task[], mode: GroupMode, lk: Lookups, statusOrder: Status[]): TaskGroup[] {
  if (mode === 'none') return [{ key: 'all', mode, id: null, tasks }];
  if (mode === 'status') {
    const groups = [...statusOrder]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map<TaskGroup>((s) => ({ key: `status:${s.id}`, mode, id: s.id, tasks: [] }));
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const t of tasks) byId.get(t.statusId)?.tasks.push(t);
    return groups;
  }
  const map = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const id = mode === 'assignee' ? t.assigneeId : t.projectId;
    const list = map.get(id) ?? [];
    list.push(t);
    map.set(id, list);
  }
  const ids = [...map.keys()];
  ids.sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    if (mode === 'project') {
      const pa = lk.projects.get(a)?.sortOrder ?? 0;
      const pb = lk.projects.get(b)?.sortOrder ?? 0;
      return pa - pb || a - b;
    }
    return collator.compare(lk.users.get(a)?.displayName ?? '', lk.users.get(b)?.displayName ?? '') || a - b;
  });
  return ids.map((id) => ({ key: `${mode}:${id ?? 'none'}`, mode, id, tasks: map.get(id)! }));
}

/** 插入列建立任務時帶入的預設值 */
export function groupDefaults(group: TaskGroup): {
  statusId?: number;
  assigneeId?: number | null;
  projectId?: number;
} {
  if (group.mode === 'status' && group.id != null) return { statusId: group.id };
  if (group.mode === 'assignee') return { assigneeId: group.id };
  if (group.mode === 'project' && group.id != null) return { projectId: group.id };
  return {};
}

// ── 狀態 / 篩選 ──────────────────────────────────

export const firstOfCategory = (statuses: Status[], category: Status['category']) =>
  [...statuses].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).find((s) => s.category === category);

/** 完成鈕：未完成 → 第一個 done 類；已完成 → 第一個 todo 類 */
export function toggleDoneStatus(statuses: Status[], currentId: number): number | null {
  const cur = statuses.find((s) => s.id === currentId);
  const target = firstOfCategory(statuses, cur?.category === 'done' ? 'todo' : 'done');
  return target?.id ?? null;
}

/** 任務是否符合 FilterBar 條件（與後端 GET /api/tasks 一致） */
export function matchesFilters(task: Task, f: TaskFilters): boolean {
  if (f.project.length && !f.project.includes(task.projectId)) return false;
  if (f.status.length && !f.status.includes(task.statusId)) return false;
  if (f.assignee.length) {
    const ok = task.assigneeId == null ? f.assignee.includes('none') : f.assignee.includes(task.assigneeId);
    if (!ok) return false;
  }
  if (f.q && !task.title.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}
