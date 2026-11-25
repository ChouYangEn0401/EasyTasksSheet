/**
 * 待辦清單的資料層：查詢 + 樂觀更新（新增 / 修改 / 刪除 / 清除已完成），失敗回復並由全域 toast 提示。
 * 查詢鍵放在 ['tasks', 'checklist', id] 之下：他人經 SSE 的 task 變更（含清單異動）會自動重抓。
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Task } from '../../../shared/tasks.ts';
import { api } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { listPollInterval } from '../../lib/sync.ts';
import {
  progressOfItems,
  sortItems,
  sortOrderLast,
  type ChecklistItem,
  type ChecklistPatch,
} from './checklistModel.ts';

export const checklistKey = (taskId: number) => ['tasks', 'checklist', taskId] as const;
const MUTATION_KEY = ['tasks', 'checklist', 'mutation'] as const;

export function useChecklist(taskId: number) {
  return useQuery({
    queryKey: checklistKey(taskId),
    queryFn: ({ signal }) => api.get<ChecklistItem[]>(`/tasks/${taskId}/checklist`, { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 新增項目的輸入：afterOrder 給定時（單項）插在該排序值之後，null = 最前面，未給 = 最後 */
export type NewItem = { text: string; isDone?: boolean };
export type AddVars = { items: NewItem[]; sortOrder?: number };

let tempSeq = 0;

type Snapshot = { prev: ChecklistItem[] | undefined };

function read(qc: QueryClient, taskId: number) {
  return qc.getQueryData<ChecklistItem[]>(checklistKey(taskId));
}

/** 清單異動後立即把進度寫回任務快取（列表 / 看板徽章不必等重抓） */
function syncCounts(qc: QueryClient, taskId: number, items: ChecklistItem[] | undefined) {
  if (!items) return;
  const p = progressOfItems(items);
  const apply = (t: Task): Task =>
    t.id === taskId && (t.checklistTotal !== p.total || t.checklistDone !== p.done)
      ? { ...t, checklistTotal: p.total, checklistDone: p.done }
      : t;
  qc.setQueriesData<Task[]>({ queryKey: queryKeys.tasks.lists() }, (list) => list?.map(apply));
  const detail = qc.getQueryData<Task>(queryKeys.tasks.detail(taskId));
  if (detail) qc.setQueryData(queryKeys.tasks.detail(taskId), apply(detail));
}

function write(qc: QueryClient, taskId: number, items: ChecklistItem[]) {
  const sorted = sortItems(items);
  qc.setQueryData(checklistKey(taskId), sorted);
  syncCounts(qc, taskId, sorted);
}

export function useChecklistActions(taskId: number) {
  const qc = useQueryClient();

  const settle = () => {
    // 其他寫入仍在進行時不重抓，避免舊資料蓋掉畫面上的樂觀狀態（SSE 事件也會等 mutation 結束）
    if (qc.isMutating({ mutationKey: MUTATION_KEY }) <= 1)
      void qc.invalidateQueries({ queryKey: checklistKey(taskId) });
    void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
  };
  const revert = (ctx: Snapshot | undefined) => {
    if (ctx?.prev) write(qc, taskId, ctx.prev);
  };

  const add = useMutation<ChecklistItem[], Error, AddVars, Snapshot & { temps: number[] }>({
    mutationKey: MUTATION_KEY,
    mutationFn: ({ items, sortOrder }) =>
      api.post<ChecklistItem[]>(
        `/tasks/${taskId}/checklist`,
        items.length === 1
          ? {
              text: items[0]!.text,
              ...(items[0]!.isDone ? { isDone: true } : {}),
              ...(sortOrder != null ? { sortOrder } : {}),
            }
          : { items },
      ),
    onMutate: async ({ items, sortOrder }) => {
      await qc.cancelQueries({ queryKey: checklistKey(taskId) });
      const prev = read(qc, taskId);
      const base = prev ?? [];
      const now = Date.now();
      let order = sortOrder ?? sortOrderLast(base) - 1;
      const temps = items.map((it) => {
        order = sortOrder != null && items.length === 1 ? sortOrder : order + 1;
        const id = -++tempSeq;
        const temp: ChecklistItem = {
          id,
          taskId,
          text: it.text,
          isDone: !!it.isDone,
          sortOrder: order,
          doneAt: it.isDone ? now : null,
          doneBy: null,
          createdBy: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        };
        return temp;
      });
      write(qc, taskId, [...base, ...temps]);
      return { prev, temps: temps.map((t) => t.id) };
    },
    onSuccess: (created, _vars, ctx) => {
      const base = (read(qc, taskId) ?? []).filter((i) => !ctx?.temps.includes(i.id));
      write(qc, taskId, [...base, ...created]);
    },
    onError: (_e, _v, ctx) => revert(ctx),
    onSettled: settle,
  });

  const patch = useMutation<ChecklistItem, Error, { id: number; patch: ChecklistPatch }, Snapshot>({
    mutationKey: MUTATION_KEY,
    mutationFn: ({ id, patch: p }) => api.patch<ChecklistItem>(`/tasks/${taskId}/checklist/${id}`, p),
    onMutate: async ({ id, patch: p }) => {
      await qc.cancelQueries({ queryKey: checklistKey(taskId) });
      const prev = read(qc, taskId);
      const now = Date.now();
      if (prev)
        write(
          qc,
          taskId,
          prev.map((i) =>
            i.id === id
              ? {
                  ...i,
                  ...p,
                  ...(p.isDone != null && p.isDone !== i.isDone
                    ? { doneAt: p.isDone ? now : null, doneBy: null }
                    : {}),
                  updatedAt: now,
                }
              : i,
          ),
        );
      return { prev };
    },
    onError: (_e, _v, ctx) => revert(ctx),
    onSettled: settle,
  });

  const remove = useMutation<{ ok: true }, Error, number, Snapshot>({
    mutationKey: MUTATION_KEY,
    mutationFn: (id) => api.delete<{ ok: true }>(`/tasks/${taskId}/checklist/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: checklistKey(taskId) });
      const prev = read(qc, taskId);
      if (prev)
        write(
          qc,
          taskId,
          prev.filter((i) => i.id !== id),
        );
      return { prev };
    },
    onError: (_e, _v, ctx) => revert(ctx),
    onSettled: settle,
  });

  const clearDone = useMutation<{ removed: number }, Error, void, Snapshot>({
    mutationKey: MUTATION_KEY,
    mutationFn: () => api.post<{ removed: number }>(`/tasks/${taskId}/checklist/clear-done`),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: checklistKey(taskId) });
      const prev = read(qc, taskId);
      if (prev)
        write(
          qc,
          taskId,
          prev.filter((i) => !i.isDone),
        );
      return { prev };
    },
    onError: (_e, _v, ctx) => revert(ctx),
    onSettled: settle,
  });

  return { add, patch, remove, clearDone };
}
