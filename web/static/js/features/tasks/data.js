/**
 * T1 的資料層：任務欄位樂觀更新、樂觀新增、自訂 property CRUD、「剛建立 / 剛移動」高亮。
 * 共用查詢鍵沿用 lib/queryClient.ts；不修改 lib。
 */
import { useCallback } from 'preact/compat';
import { useMutation, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';

import { enterItem, flashItem, leaveItem, taskFxKey } from '../../lib/motion.js';
import { queryKeys } from '../../lib/queryClient.js';
import { findCachedTask, recordTaskCreate, recordTaskDelete, recordTaskUpdate } from '../../lib/taskUndo.js';
import { applyPatch, matchesFilters } from './model.js';

// ── 高亮（剛建立 / 剛因編輯而移動）：共用 lib/motion.ts 的項目效果 ──

export function flashTask(id) {
  flashItem(taskFxKey(id));
}

// ── 快取工具 ───────────────────────────────────────

function listEntries(qc) {
  return qc.getQueriesData({ queryKey: queryKeys.tasks.lists() });
}

function filtersOf(key) {
  return key[2];
}

/** 以 fn 改寫所有任務清單快取 */
function updateLists(qc, fn) {
  for (const [key, list] of listEntries(qc)) {
    if (list) qc.setQueryData(key, fn(list, filtersOf(key)));
  }
}

function findTask(qc, id) {
  const detail = qc.getQueryData(queryKeys.tasks.detail(id));
  if (detail) return detail;
  for (const [, list] of listEntries(qc)) {
    const t = list?.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

// ── 欄位更新（樂觀）────────────────────────────────

/** PATCH 單一欄位：立即套用到所有快取，失敗回復 */
export function useOptimisticUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) => api.patch(`/tasks/${id}`, patch),
    onMutate: async ({ id, patch, userId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.tasks.all });
      const lists = listEntries(qc);
      const detail = qc.getQueryData(queryKeys.tasks.detail(id));
      // 復原用的前值：樂觀套用前從快取取出（lib/taskUndo.ts）
      const before = findCachedTask(qc, id);
      const now = Date.now();
      updateLists(qc, (list) => list.map((t) => (t.id === id ? applyPatch(t, patch, now, userId) : t)));
      if (detail) qc.setQueryData(queryKeys.tasks.detail(id), applyPatch(detail, patch, now, userId));
      return { lists, detail, before };
    },
    onError: (_err, { id }, ctx) => {
      if (!ctx) return;
      for (const [key, list] of ctx.lists) qc.setQueryData(key, list);
      if (ctx.detail) qc.setQueryData(queryKeys.tasks.detail(id), ctx.detail);
    },
    onSuccess: (task, { id, patch, undo }, ctx) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      // 合併而非取代：PATCH 回應不含清單專用的 relationCount
      updateLists(qc, (list) => list.map((t) => (t.id === task.id ? { ...t, ...task } : t)));
      recordTaskUpdate(qc, { id, patch, before: ctx?.before, result: task, option: undo });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
  });
}

// ── 新增（樂觀插入）────────────────────────────────

let tempSeq = 0;

/**
 * 樂觀新增：立即在符合條件的清單末端插入暫時列（負 id），成功後換成正式資料並高亮；
 * 失敗則移除。回傳 promise（成功值含「是否符合目前篩選」）。
 */
export function useOptimisticCreate() {
  const qc = useQueryClient();
  return useCallback(
    async (input, temp, current) => {
      const tempId = -++tempSeq;
      const tempTask = { ...temp, id: tempId };
      await qc.cancelQueries({ queryKey: queryKeys.tasks.lists() });
      updateLists(qc, (list, f) => (!f || matchesFilters(tempTask, f) ? [...list, tempTask] : list));
      try {
        const task = await api.post('/tasks', input);
        qc.setQueryData(queryKeys.tasks.detail(task.id), task);
        updateLists(qc, (list, f) => {
          const without = list.filter((t) => t.id !== tempId);
          return !f || matchesFilters(task, f) ? [...without, task] : without;
        });
        enterItem(taskFxKey(task.id));
        recordTaskCreate(qc, task);
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
        return { task, matches: matchesFilters(task, current) };
      } catch (err) {
        updateLists(qc, (list) => list.filter((t) => t.id !== tempId));
        throw err;
      }
    },
    [qc],
  );
}

// ── 刪除任務 ───────────────────────────────────────

export function useDeleteTaskOptimistic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.delete(`/tasks/${id}`),
    onMutate: (id) => ({ title: findTask(qc, id)?.title ?? '' }),
    onSuccess: async (_r, id, ctx) => {
      recordTaskDelete(qc, { id, title: ctx?.title ?? '' });
      // 清單列先播離場動畫，再從快取移除
      const ms = leaveItem(taskFxKey(id));
      if (ms > 0) await new Promise((r) => window.setTimeout(r, ms));
      updateLists(qc, (list) => list.filter((t) => t.id !== id));
      // Drawer 仍開著時不移除（否則會立即重抓而得到 404）；關閉後由快取回收
      const detail = qc.getQueryCache().find({ queryKey: queryKeys.tasks.detail(id) });
      if (!detail?.getObserversCount()) qc.removeQueries({ queryKey: queryKeys.tasks.detail(id) });
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

// ── 自訂 property ──────────────────────────────────

export function useCreateProperty() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/properties', input),
    onSuccess: (p) => {
      qc.setQueryData(queryKeys.properties, (prev) => (prev ? [...prev, p] : [p]));
      return qc.invalidateQueries({ queryKey: queryKeys.properties });
    },
  });
}

export function useUpdateProperty() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...input }) => api.patch(`/properties/${id}`, input),
    onMutate: async ({ id, ...input }) => {
      await qc.cancelQueries({ queryKey: queryKeys.properties });
      const prev = qc.getQueryData(queryKeys.properties);
      qc.setQueryData(queryKeys.properties, (list) =>
        list?.map((p) => (p.id === id ? { ...p, ...input } : p)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.properties, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.properties }),
  });
}

export function useDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/properties/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueryData(queryKeys.properties, (list) => list?.filter((p) => p.id !== id));
      return qc.invalidateQueries({ queryKey: queryKeys.properties });
    },
  });
}

export { findTask };
