/**
 * 待辦清單的資料層：查詢 + 樂觀更新（新增 / 修改 / 刪除 / 清除已完成），失敗回復並由全域 toast 提示。
 * 查詢鍵放在 ['tasks', 'detail', id, 'checklist'] 之下：他人經 SSE 的 task 變更（含清單異動）會自動重抓；
 * 任務刪除後隨詳情一併排除重抓（lib/sync.ts）。
 */
import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { listPollInterval } from '../../lib/sync.js';
import { progressOfItems, sortItems, sortOrderLast } from './checklistModel.js';

/** 掛在任務詳情之下：任務刪除時隨詳情一併排除重抓 / 移除（lib/sync.ts） */
export const checklistKey = (taskId) => [...queryKeys.tasks.detail(taskId), 'checklist'];
const MUTATION_KEY = ['tasks', 'checklist', 'mutation'];

export function useChecklist(taskId, enabled = true) {
  return useQuery({
    queryKey: checklistKey(taskId),
    queryFn: ({ signal }) => api.get(`/tasks/${taskId}/checklist`, { signal }),
    enabled,
    refetchInterval: listPollInterval,
  });
}

/** 新增項目的輸入：afterOrder 給定時（單項）插在該排序值之後，null = 最前面，未給 = 最後 */

let tempSeq = 0;

function read(qc, taskId) {
  return qc.getQueryData(checklistKey(taskId));
}

/** 清單異動後立即把進度寫回任務快取（列表 / 看板徽章不必等重抓） */
function syncCounts(qc, taskId, items) {
  if (!items) return;
  const p = progressOfItems(items);
  const apply = (t) =>
    t.id === taskId && (t.checklistTotal !== p.total || t.checklistDone !== p.done)
      ? { ...t, checklistTotal: p.total, checklistDone: p.done }
      : t;
  qc.setQueriesData({ queryKey: queryKeys.tasks.lists() }, (list) => list?.map(apply));
  const detail = qc.getQueryData(queryKeys.tasks.detail(taskId));
  if (detail) qc.setQueryData(queryKeys.tasks.detail(taskId), apply(detail));
}

function write(qc, taskId, items) {
  const sorted = sortItems(items);
  qc.setQueryData(checklistKey(taskId), sorted);
  syncCounts(qc, taskId, sorted);
}

export function useChecklistActions(taskId) {
  const qc = useQueryClient();

  const settle = () => {
    // 其他寫入仍在進行時不重抓，避免舊資料蓋掉畫面上的樂觀狀態（SSE 事件也會等 mutation 結束）
    if (qc.isMutating({ mutationKey: MUTATION_KEY }) <= 1)
      void qc.invalidateQueries({ queryKey: checklistKey(taskId) });
    void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId), exact: true });
  };
  const revert = (ctx) => {
    if (ctx?.prev) write(qc, taskId, ctx.prev);
  };

  const add = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: ({ items, sortOrder }) =>
      api.post(
        `/tasks/${taskId}/checklist`,
        items.length === 1
          ? {
              text: items[0].text,
              ...(items[0].isDone ? { isDone: true } : {}),
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
        const temp = {
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

  const patch = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: ({ id, patch: p }) => api.patch(`/tasks/${taskId}/checklist/${id}`, p),
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

  const remove = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: (id) => api.delete(`/tasks/${taskId}/checklist/${id}`),
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

  const clearDone = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: () => api.post(`/tasks/${taskId}/checklist/clear-done`),
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
