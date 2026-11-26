import { useMemo } from 'preact/compat';
import { useMutation, useQuery, useQueryClient } from '../lib/query.js';

import { api } from './api.js';
import { emptyFilters, toTaskQueryString } from './filters.js';
import { queryKeys } from './queryClient.js';
import { listPollInterval } from './sync.js';
import { findCachedTask, recordTaskCreate, recordTaskDelete, recordTaskUpdate } from './taskUndo.js';

/*
 * 共用資料 hooks（tasks / users / projects / statuses / properties）。
 * 即時同步（SSE）正常時由事件觸發重抓；中斷時退回每 30 秒輪詢。另有視窗 focus 重抓。
 * 輪詢不刷新後端閒置計時（GET 不算活動）。
 */

/** 任務清單；filters 通常來自 useTaskFilters()（URL 驅動） */
export function useTasks(filters = emptyFilters(), options = {}) {
  return useQuery({
    queryKey: queryKeys.tasks.list(filters),
    queryFn: ({ signal }) => api.get(`/tasks${toTaskQueryString(filters)}`, { signal }),
    refetchInterval: listPollInterval,
    placeholderData: (prev) => prev,
    enabled: options.enabled,
  });
}

/** 單一任務；id 為 null 時不查詢 */
export function useTask(id) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? 0),
    queryFn: ({ signal }) => api.get(`/tasks/${id}`, { signal }),
    enabled: id != null && id > 0,
    refetchInterval: listPollInterval,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ undo: _undo, ...input }) => api.post('/tasks', input),
    onSuccess: (task, { undo }) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      recordTaskCreate(qc, task, undo);
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

/**
 * PATCH 任務。成功後自動登記復原（lib/taskUndo.ts）：前值於 onMutate 從快取取出；
 * 呼叫端若已先樂觀改寫快取，請在 undo.before 帶動作前的值；undo: false 不入堆疊。
 * silentError：呼叫端自行顯示失敗（含重試）時設為 true，不發全域失敗 toast
 */
export function useUpdateTask({ silentError = false } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silentError ? { errorToast: false } : undefined,
    mutationFn: ({ id, undo: _undo, ...patch }) => api.patch(`/tasks/${id}`, patch),
    onMutate: ({ id, undo }) => ({
      before: undo === false ? undefined : (undo?.before ?? findCachedTask(qc, id)),
    }),
    onSuccess: (task, { id, undo, ...patch }, ctx) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      recordTaskUpdate(qc, { id, patch, before: ctx?.before, result: task, option: undo });
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

/** 軟刪除任務；成功後登記復原（undo: false 不入堆疊） */
export function useDeleteTask({ undo } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.delete(`/tasks/${id}`),
    onMutate: (id) => ({ title: findCachedTask(qc, id)?.title ?? '' }),
    onSuccess: (_res, id, ctx) => {
      qc.removeQueries({ queryKey: queryKeys.tasks.detail(id) });
      recordTaskDelete(qc, { id, title: ctx?.title ?? '' }, undo);
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

/** 成員（含停用者；畫面上的選單請自行過濾 isActive） */
export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.get('/users', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 專案（含封存；選單請自行過濾 isArchived） */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => api.get('/projects', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 狀態（已依 sortOrder 排序） */
export function useStatuses() {
  return useQuery({
    queryKey: queryKeys.statuses,
    queryFn: ({ signal }) => api.get('/statuses', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 自訂 property 定義（projectId = null 為全域） */
export function useProperties() {
  return useQuery({
    queryKey: queryKeys.properties,
    queryFn: ({ signal }) => api.get('/properties', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 各狀態被任務使用的筆數（含已刪除任務；statusId 字串 → 筆數）。管理狀態對話框用 */
export function useStatusUsage(enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.statuses, 'usage'],
    queryFn: ({ signal }) => api.get('/statuses/usage', { signal }),
    enabled,
  });
}

/** 建立專案（projects.create）。成功後重抓專案清單 */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => api.post('/projects', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/** 專案改名 / 改色 / 封存（projects.manage） */
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }) => api.patch(`/projects/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/** 狀態新增 / 修改 / 刪除（statuses.manage）；成功後重抓狀態（含使用數）與任務清單 */
export function useCreateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => api.post('/statuses', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.statuses }),
  });
}

export function useUpdateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }) => api.patch(`/statuses/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.statuses }),
  });
}

/** 刪除狀態；有任務使用且給了 targetStatusId 時，先把任務改移到目標狀態再刪除（單一 transaction） */
export function useDeleteStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetStatusId }) =>
      targetStatusId != null
        ? api.post(`/statuses/${id}/migrate-and-delete`, { targetStatusId })
        : api.delete(`/statuses/${id}`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.statuses }),
        qc.invalidateQueries({ queryKey: queryKeys.tasks.all }),
      ]),
  });
}

function useById(list) {
  return useMemo(() => new Map((list ?? []).map((x) => [x.id, x])), [list]);
}

/** 以 id 查找的 Map（資料尚未載入時為空 Map） */
export const useUsersById = () => useById(useUsers().data);
export const useProjectsById = () => useById(useProjects().data);
export const useStatusesById = () => useById(useStatuses().data);
