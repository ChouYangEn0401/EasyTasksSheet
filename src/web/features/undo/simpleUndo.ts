import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { FeedbackCreateInput, FeedbackItem } from '../../../shared/feedback.ts';
import {
  PERSONAL_STATUS_LABEL,
  type PersonalCreateInput,
  type PersonalItem,
  type PersonalUpdateInput,
} from '../../../shared/personal.ts';
import { ApiError, api } from '../../lib/api.ts';
import { quote } from '../../lib/taskUndoModel.ts';
import { toast } from '../../lib/toast.ts';
import { registerUndoable, type UndoOutcome } from '../../lib/undo.ts';

/*
 * 個人待辦（自由待辦）與問題回饋的復原（docs/design/undo.md「其他功能」）。
 * 這兩者後端為硬刪除，因此「復原刪除 / 重做新增」是以相同內容重新建立（會得到新的 id，
 * 以閉包內的 ref 追蹤最新 id）。不做衝突檢查（自由待辦只有本人能改）。
 */

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

async function orDrop(fn: () => Promise<unknown>, label: string): Promise<UndoOutcome> {
  try {
    await fn();
  } catch (err) {
    if (!isNotFound(err)) throw err;
    toast({ tone: 'warning', title: '此項目已不存在', description: `已從復原紀錄移除：${label}` });
    return 'drop';
  }
}

// ── 個人待辦 ─────────────────────────────────────────

const todoInput = (item: PersonalItem): PersonalCreateInput => ({
  title: item.title,
  note: item.note,
  detail: item.detail,
  status: item.status,
  dueDate: item.dueDate,
});

/** 以相同內容重建待辦，並放回原本的位置 */
async function recreateTodo(qc: QueryClient, key: QueryKey, item: PersonalItem): Promise<PersonalItem> {
  const created = await api.post<PersonalItem>('/personal', todoInput(item));
  const placed = await api.patch<PersonalItem>(`/personal/${created.id}`, { sortOrder: item.sortOrder });
  await qc.invalidateQueries({ queryKey: key });
  return placed;
}

async function deleteTodo(qc: QueryClient, key: QueryKey, id: number) {
  qc.setQueryData<PersonalItem[]>(key, (list) => list?.filter((i) => i.id !== id));
  try {
    await api.delete(`/personal/${id}`);
  } finally {
    await qc.invalidateQueries({ queryKey: key });
  }
}

export function recordTodoCreate(qc: QueryClient, key: QueryKey, item: PersonalItem) {
  const ref = { item };
  const label = `新增待辦${quote(item.title)}`;
  registerUndoable({
    label,
    undo: () => orDrop(() => deleteTodo(qc, key, ref.item.id), label),
    redo: async () => {
      ref.item = await recreateTodo(qc, key, ref.item);
    },
  });
}

export function recordTodoDelete(qc: QueryClient, key: QueryKey, item: PersonalItem) {
  const ref = { item };
  const label = `刪除待辦${quote(item.title)}`;
  registerUndoable({
    label,
    undo: async () => {
      ref.item = await recreateTodo(qc, key, ref.item);
    },
    redo: () => orDrop(() => deleteTodo(qc, key, ref.item.id), label),
  });
}

function todoUpdateLabel(item: PersonalItem, patch: PersonalUpdateInput): string {
  if (patch.status !== undefined)
    return `把待辦${quote(item.title)}改為${quote(PERSONAL_STATUS_LABEL[patch.status])}`;
  if (patch.isDone !== undefined)
    return patch.isDone ? `完成待辦${quote(item.title)}` : `取消完成待辦${quote(item.title)}`;
  if (patch.title !== undefined) return `修改待辦${quote(item.title)}的內容`;
  if (patch.sortOrder !== undefined && Object.keys(patch).length === 1)
    return `調整待辦${quote(item.title)}的順序`;
  return `修改待辦${quote(item.title)}`;
}

/** PATCH 成功後登記：復原 = PATCH 回前值（只含這次改動的欄位） */
export function recordTodoUpdate(
  qc: QueryClient,
  key: QueryKey,
  before: PersonalItem | undefined,
  patch: PersonalUpdateInput,
  result: PersonalItem,
) {
  if (!before) return;
  const fields = Object.keys(patch).filter((k) => patch[k as keyof PersonalUpdateInput] !== undefined);
  // isDone 與 status 由後端同步維護：一律以 status 回復
  const keys = fields.includes('isDone') ? [...fields.filter((k) => k !== 'isDone'), 'status'] : fields;
  const pick = (item: PersonalItem) =>
    Object.fromEntries(keys.map((k) => [k, item[k as keyof PersonalItem] ?? null])) as PersonalUpdateInput;
  const prev = pick(before);
  const next = pick(result);
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  const label = todoUpdateLabel(before, patch);
  const apply = (body: PersonalUpdateInput) => async () => {
    try {
      await api.patch(`/personal/${result.id}`, body);
    } finally {
      await qc.invalidateQueries({ queryKey: key });
    }
  };
  registerUndoable({
    label,
    mergeKey: `todo:${result.id}:${keys.sort().join(',')}`,
    undo: () => orDrop(apply(prev), label),
    redo: () => orDrop(apply(next), label),
  });
}

// ── 問題回饋 ─────────────────────────────────────────

const FEEDBACK_ALL = ['feedback'] as const;

/** 新增回饋成功後登記：復原 = 刪除；重做 = 以相同內容重新建立。key 為回饋清單的查詢鍵 */
export function recordFeedbackCreate(
  qc: QueryClient,
  key: QueryKey,
  item: FeedbackItem,
  input: FeedbackCreateInput,
) {
  const ref = { id: item.id };
  const label = `新增${item.kind === 'problem' ? '問題' : '回饋'}${quote(item.title)}`;
  registerUndoable({
    label,
    undo: () =>
      orDrop(async () => {
        qc.setQueryData<FeedbackItem[]>(key, (list) => list?.filter((i) => i.id !== ref.id));
        try {
          await api.delete(`/feedback/${ref.id}`);
        } finally {
          await qc.invalidateQueries({ queryKey: FEEDBACK_ALL });
        }
      }, label),
    redo: async () => {
      ref.id = (await api.post<FeedbackItem>('/feedback', input)).id;
      await qc.invalidateQueries({ queryKey: FEEDBACK_ALL });
    },
  });
}
