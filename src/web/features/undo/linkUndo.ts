import type { QueryClient } from '@tanstack/react-query';
import type { DependencyCreateInput, DependencyMutationResult } from '../../../shared/dependencies.ts';
import type { TaskRelation } from '../../../shared/taskRelations.ts';
import { ApiError, api } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { quote } from '../../lib/taskUndoModel.ts';
import { toast } from '../../lib/toast.ts';
import { performUndoEntry, registerUndoable, type UndoInput, type UndoOutcome } from '../../lib/undo.ts';
import { checklistKey } from '../tasks/checklistData.ts';
import type { ChecklistItem } from '../tasks/checklistModel.ts';

/*
 * 相關任務、依賴與待辦清單的復原 / 重做（docs/design/undo.md §3「其他資料」）。
 * 這些資料後端為硬刪除，「復原移除 / 重做新增」以相同內容重新建立（得到新 id，以閉包內的 ref 追蹤最新 id）。
 * 對象已不存在（404）時回傳 'drop'，從堆疊移除。
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

const refreshTasks = (qc: QueryClient) => qc.invalidateQueries({ queryKey: queryKeys.tasks.all });

/** 登記後的項目：id 給 toast 的「復原」使用（null = 未入堆疊） */
export type UndoHandle = { id: number | null; label: string };

/**
 * toast 上的「復原」：以項目 id 執行（lib/undo.ts performUndoEntry）——在頂端走一般復原（之後可重做）；
 * 不在頂端則執行後從堆疊移除（之後 Ctrl+Z 不會重複執行）；已復原過則不做事。錯誤照常提示。
 */
export function undoFromToast(entry: UndoHandle): void {
  void performUndoEntry(entry.id);
}

function register(input: UndoInput): UndoHandle {
  return { id: registerUndoable(input), label: input.label };
}

// ── 相關任務 ─────────────────────────────────────────

const relationLabel = (verb: string, rel: TaskRelation) => `${verb}相關任務${quote(rel.task.title)}`;

export function recordRelationAdd(qc: QueryClient, taskId: number, rel: TaskRelation): UndoHandle {
  const ref = { id: rel.id };
  const label = relationLabel('新增', rel);
  return register({
    label,
    undo: () =>
      orDrop(async () => {
        try {
          await api.delete(`/tasks/${taskId}/relations/${ref.id}`);
        } finally {
          await refreshTasks(qc);
        }
      }, label),
    redo: () =>
      orDrop(async () => {
        try {
          ref.id = (
            await api.post<TaskRelation>(`/tasks/${taskId}/relations`, {
              type: 'related',
              targetId: rel.task.id,
            })
          ).id;
        } finally {
          await refreshTasks(qc);
        }
      }, label),
  });
}

export function recordRelationRemove(qc: QueryClient, taskId: number, rel: TaskRelation): UndoHandle {
  const ref = { id: rel.id };
  const label = relationLabel('移除', rel);
  return register({
    label,
    undo: () =>
      orDrop(async () => {
        try {
          ref.id = (
            await api.post<TaskRelation>(`/tasks/${taskId}/relations`, {
              type: 'related',
              targetId: rel.task.id,
            })
          ).id;
        } finally {
          await refreshTasks(qc);
        }
      }, label),
    redo: () =>
      orDrop(async () => {
        try {
          await api.delete(`/tasks/${taskId}/relations/${ref.id}`);
        } finally {
          await refreshTasks(qc);
        }
      }, label),
  });
}

// ── 依賴 ─────────────────────────────────────────────

export function recordDependencyAdd(
  qc: QueryClient,
  taskId: number,
  input: DependencyCreateInput,
  created: DependencyMutationResult,
  title: string,
): UndoHandle {
  const ref = { id: created.id };
  const label = `${input.direction === 'blocked_by' ? '加入前置任務' : '加入後續任務'}${quote(title)}`;
  return register({
    label,
    undo: () =>
      orDrop(async () => {
        try {
          await api.delete(`/tasks/${taskId}/dependencies/${ref.id}`);
        } finally {
          await refreshTasks(qc);
        }
      }, label),
    redo: () =>
      orDrop(async () => {
        try {
          ref.id = (await api.post<DependencyMutationResult>(`/tasks/${taskId}/dependencies`, input)).id;
        } finally {
          await refreshTasks(qc);
        }
      }, label),
  });
}

export function recordDependencyRemove(
  qc: QueryClient,
  taskId: number,
  depId: number,
  input: DependencyCreateInput,
  title: string,
): UndoHandle {
  const ref = { id: depId };
  const label = `移除依賴${quote(title)}`;
  return register({
    label,
    undo: () =>
      orDrop(async () => {
        try {
          ref.id = (await api.post<DependencyMutationResult>(`/tasks/${taskId}/dependencies`, input)).id;
        } finally {
          await refreshTasks(qc);
        }
      }, label),
    redo: () =>
      orDrop(async () => {
        try {
          await api.delete(`/tasks/${taskId}/dependencies/${ref.id}`);
        } finally {
          await refreshTasks(qc);
        }
      }, label),
  });
}

// ── 待辦清單 ─────────────────────────────────────────

async function refreshChecklist(qc: QueryClient, taskId: number) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: checklistKey(taskId) }),
    qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
    qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId), exact: true }),
  ]);
}

type NewChecklistItem = { text: string; isDone: boolean; sortOrder: number };

/** 依序重建項目（單項時保留原排序位置）；回傳新 id */
async function recreateItems(taskId: number, items: NewChecklistItem[]): Promise<number[]> {
  if (items.length === 1) {
    const [it] = items;
    const created = await api.post<ChecklistItem[]>(`/tasks/${taskId}/checklist`, {
      text: it!.text,
      ...(it!.isDone ? { isDone: true } : {}),
      sortOrder: it!.sortOrder,
    });
    return created.map((c) => c.id);
  }
  const created = await api.post<ChecklistItem[]>(`/tasks/${taskId}/checklist`, {
    items: items.map((i) => ({ text: i.text, isDone: i.isDone })),
  });
  return created.map((c) => c.id);
}

async function deleteItems(taskId: number, ids: number[]) {
  const results = await Promise.allSettled(ids.map((id) => api.delete(`/tasks/${taskId}/checklist/${id}`)));
  const failed = results.find((r) => r.status === 'rejected' && !isNotFound(r.reason));
  if (failed && failed.status === 'rejected') throw failed.reason;
  if (results.every((r) => r.status === 'rejected')) throw new ApiError(404, 'NOT_FOUND', '項目已不存在');
}

const snap = (i: ChecklistItem): NewChecklistItem => ({
  text: i.text,
  isDone: i.isDone,
  sortOrder: i.sortOrder,
});

export function recordChecklistAdd(
  qc: QueryClient,
  taskId: number,
  created: ChecklistItem[],
): UndoHandle | null {
  if (created.length === 0) return null;
  const ref = { ids: created.map((c) => c.id) };
  const items = created.map(snap);
  const label =
    created.length === 1 ? `新增待辦項目${quote(created[0]!.text)}` : `新增 ${created.length} 項待辦`;
  return register({
    label,
    undo: () =>
      orDrop(async () => {
        try {
          await deleteItems(taskId, ref.ids);
        } finally {
          await refreshChecklist(qc, taskId);
        }
      }, label),
    redo: async () => {
      try {
        ref.ids = await recreateItems(taskId, items);
      } finally {
        await refreshChecklist(qc, taskId);
      }
    },
  });
}

export function recordChecklistToggle(
  qc: QueryClient,
  taskId: number,
  item: ChecklistItem,
  isDone: boolean,
): UndoHandle {
  const label = `${isDone ? '勾選' : '取消勾選'}待辦項目${quote(item.text)}`;
  const apply = (value: boolean) => () =>
    orDrop(async () => {
      try {
        await api.patch(`/tasks/${taskId}/checklist/${item.id}`, { isDone: value });
      } finally {
        await refreshChecklist(qc, taskId);
      }
    }, label);
  return register({
    label,
    mergeKey: `checklist:${item.id}:done`,
    meta: { from: !isDone },
    undo: apply(!isDone),
    redo: apply(isDone),
    // 1.5 秒內勾選又取消：回到原值，移出堆疊
    merge: (older) => ({
      label,
      meta: { from: older.meta?.from },
      undo: older.undo,
      redo: apply(isDone),
      noop: older.meta?.from === isDone,
    }),
  });
}

export function recordChecklistDelete(qc: QueryClient, taskId: number, item: ChecklistItem): UndoHandle {
  const ref = { id: item.id };
  const label = `刪除待辦項目${quote(item.text)}`;
  return register({
    label,
    undo: async () => {
      try {
        ref.id = (await recreateItems(taskId, [snap(item)]))[0] ?? ref.id;
      } finally {
        await refreshChecklist(qc, taskId);
      }
    },
    redo: () =>
      orDrop(async () => {
        try {
          await api.delete(`/tasks/${taskId}/checklist/${ref.id}`);
        } finally {
          await refreshChecklist(qc, taskId);
        }
      }, label),
  });
}
