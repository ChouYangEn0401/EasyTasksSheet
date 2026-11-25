import type { Task, TaskUpdateInput } from '../../shared/tasks.ts';

/*
 * 任務復原的純函式（docs/design/undo.md）：把 PATCH 攤平成「欄位 → 值」、比對衝突、合併、組文案。
 * 自訂欄位逐鍵處理，鍵為 `custom.<propertyId>`；不存在的值一律視為 null（PATCH 送 null = 清除）。
 */

/** 欄位 → 值（custom 以 `custom.<key>` 攤平） */
export type FieldMap = Record<string, unknown>;

export type TaskFieldChange = {
  id: number;
  title: string;
  before: FieldMap;
  after: FieldMap;
};

const CUSTOM_PREFIX = 'custom.';

/** 不做衝突檢查的欄位：排序值會因任何人的拖曳而重新編號，比對只會誤報 */
export const CONFLICT_IGNORED_FIELDS: ReadonlySet<string> = new Set(['sortOrder']);

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** PATCH 會動到的欄位鍵 */
export function fieldKeysOf(patch: TaskUpdateInput): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'custom') {
      for (const ck of Object.keys((v as Record<string, unknown>) ?? {})) keys.push(CUSTOM_PREFIX + ck);
    } else keys.push(k);
  }
  return keys;
}

/** 從任務（可為部分欄位）取出指定欄位目前的值 */
export function pickFields(task: Partial<Task>, keys: readonly string[]): FieldMap {
  const out: FieldMap = {};
  for (const k of keys) {
    if (k.startsWith(CUSTOM_PREFIX)) out[k] = task.custom?.[k.slice(CUSTOM_PREFIX.length)] ?? null;
    else out[k] = (task as Record<string, unknown>)[k] ?? null;
  }
  return out;
}

/** 欄位 → 值 轉回 PATCH body */
export function toTaskPatch(fields: FieldMap): TaskUpdateInput {
  const patch: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith(CUSTOM_PREFIX)) custom[k.slice(CUSTOM_PREFIX.length)] = v ?? null;
    else patch[k] = v ?? null;
  }
  if (Object.keys(custom).length) patch.custom = custom;
  return patch as TaskUpdateInput;
}

/** 前後值是否完全相同（沒有實際變更，不入堆疊） */
export function isNoop(change: Pick<TaskFieldChange, 'before' | 'after'>): boolean {
  return Object.keys(change.after).every((k) => sameValue(change.before[k], change.after[k]));
}

export type FieldConflict = { field: string; expected: unknown; current: unknown };

/**
 * 衝突判斷：目前值（最新資料）與預期值（復原時 = 動作寫入的值；重做時 = 動作前的值）不同的欄位。
 * 排序值不比對（CONFLICT_IGNORED_FIELDS）。
 */
export function findConflicts(
  current: FieldMap,
  expected: FieldMap,
  ignored: ReadonlySet<string> = CONFLICT_IGNORED_FIELDS,
): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const [field, value] of Object.entries(expected)) {
    if (ignored.has(field)) continue;
    if (!sameValue(current[field], value))
      out.push({ field, expected: value, current: current[field] ?? null });
  }
  return out;
}

/**
 * 合併兩筆（或多筆）欄位變更：同一任務的 before 以最早的為準、after 以最新的為準；
 * 不同任務各自保留（例如同一次拖曳放下的多張卡片）。
 */
export function mergeChanges(older: TaskFieldChange[], newer: TaskFieldChange[]): TaskFieldChange[] {
  const out = older.map((c) => ({ ...c, before: { ...c.before }, after: { ...c.after } }));
  for (const n of newer) {
    const o = out.find((c) => c.id === n.id);
    if (!o) {
      out.push({ ...n, before: { ...n.before }, after: { ...n.after } });
      continue;
    }
    for (const [k, v] of Object.entries(n.before)) if (!(k in o.before)) o.before[k] = v;
    Object.assign(o.after, n.after);
    o.title = n.title;
  }
  return out;
}

/** 欄位的中文名稱 */
export const TASK_FIELD_LABELS: Record<string, string> = {
  title: '標題',
  description: '描述',
  statusId: '狀態',
  assigneeId: '負責人',
  priority: '優先度',
  startDate: '開始日',
  dueDate: '截止日',
  estimateHours: '預估工時',
  progress: '進度',
  projectId: '專案',
  sortOrder: '順序',
  descriptionLocked: '描述鎖定',
};

export function fieldLabel(field: string, propertyName?: (key: string) => string | undefined): string {
  if (field.startsWith(CUSTOM_PREFIX)) return propertyName?.(field.slice(CUSTOM_PREFIX.length)) ?? '自訂欄位';
  return TASK_FIELD_LABELS[field] ?? field;
}

/** 名稱用『』包住並截斷為 20 字 */
export function quote(name: string, max = 20): string {
  const chars = [...name.trim()];
  return `『${chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')}』`;
}

/**
 * 更新動作的文案：
 * - 含狀態變更 → 把『X』移到『進行中』
 * - 只有排序 → 調整『X』的順序
 * - 單一欄位 → 修改『X』的標題
 * - 多個欄位 → 修改『X』的 3 個欄位（多張卡片時以第一張為主）
 */
export function describeTaskUpdate(
  changes: TaskFieldChange[],
  lookup: {
    statusName?: (id: number) => string | undefined;
    propertyName?: (key: string) => string | undefined;
  } = {},
): string {
  const moved = changes.find((c) => 'statusId' in c.after && !sameValue(c.before.statusId, c.after.statusId));
  if (moved) {
    const name = lookup.statusName?.(Number(moved.after.statusId));
    return name ? `把${quote(moved.title)}移到${quote(name)}` : `修改${quote(moved.title)}的狀態`;
  }
  const main = changes[0];
  if (!main) return '修改任務';
  const fields = Object.keys(main.after).filter((k) => !sameValue(main.before[k], main.after[k]));
  const meaningful = fields.filter((f) => f !== 'sortOrder');
  if (meaningful.length === 0) return `調整${quote(main.title)}的順序`;
  if (meaningful.length === 1)
    return `修改${quote(main.title)}的${fieldLabel(meaningful[0]!, lookup.propertyName)}`;
  return `修改${quote(main.title)}的 ${meaningful.length} 個欄位`;
}

/** 依 PATCH 樂觀套用到任務（custom 逐鍵合併，null = 清除） */
export function applyTaskPatch(task: Task, patch: TaskUpdateInput): Task {
  const { custom, ...rest } = patch;
  const next = { ...task } as Record<string, unknown>;
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) next[k] = v;
  if (custom) {
    const merged = { ...task.custom } as Record<string, unknown>;
    for (const [k, v] of Object.entries(custom)) {
      if (v == null) delete merged[k];
      else merged[k] = v;
    }
    next.custom = merged;
  }
  return next as Task;
}
