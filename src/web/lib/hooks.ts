import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project, Status } from '../../shared/projects.ts';
import type { PropertyDef } from '../../shared/properties.ts';
import type { Task, TaskCreateInput, TaskUpdateInput } from '../../shared/tasks.ts';
import type { PublicUser } from '../../shared/users.ts';
import { api } from './api.ts';
import { emptyFilters, toTaskQueryString, type TaskFilters } from './filters.ts';
import { queryKeys } from './queryClient.ts';
import { listPollInterval } from './sync.ts';

/*
 * 共用資料 hooks（tasks / users / projects / statuses / properties）。
 * 即時同步（SSE）正常時由事件觸發重抓；中斷時退回每 30 秒輪詢。另有視窗 focus 重抓。
 * 輪詢不刷新後端閒置計時（GET 不算活動）。
 */

/** 任務清單；filters 通常來自 useTaskFilters()（URL 驅動） */
export function useTasks(filters: TaskFilters = emptyFilters(), options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.tasks.list(filters),
    queryFn: ({ signal }) => api.get<Task[]>(`/tasks${toTaskQueryString(filters)}`, { signal }),
    refetchInterval: listPollInterval,
    placeholderData: (prev) => prev,
    enabled: options.enabled,
  });
}

/** 單一任務；id 為 null 時不查詢 */
export function useTask(id: number | null | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? 0),
    queryFn: ({ signal }) => api.get<Task>(`/tasks/${id}`, { signal }),
    enabled: id != null && id > 0,
    refetchInterval: listPollInterval,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskCreateInput) => api.post<Task>('/tasks', input),
    onSuccess: (task) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

/** silentError：呼叫端自行顯示失敗（含重試）時設為 true，不發全域失敗 toast */
export function useUpdateTask({ silentError = false }: { silentError?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silentError ? { errorToast: false } : undefined,
    mutationFn: ({ id, ...patch }: TaskUpdateInput & { id: number }) =>
      api.patch<Task>(`/tasks/${id}`, patch),
    onSuccess: (task) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/tasks/${id}`),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: queryKeys.tasks.detail(id) });
      return qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
    },
  });
}

/** 成員（含停用者；畫面上的選單請自行過濾 isActive） */
export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.get<PublicUser[]>('/users', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 專案（含封存；選單請自行過濾 isArchived） */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => api.get<Project[]>('/projects', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 狀態（已依 sortOrder 排序） */
export function useStatuses() {
  return useQuery({
    queryKey: queryKeys.statuses,
    queryFn: ({ signal }) => api.get<Status[]>('/statuses', { signal }),
    refetchInterval: listPollInterval,
  });
}

/** 自訂 property 定義（projectId = null 為全域） */
export function useProperties() {
  return useQuery({
    queryKey: queryKeys.properties,
    queryFn: ({ signal }) => api.get<PropertyDef[]>('/properties', { signal }),
    refetchInterval: listPollInterval,
  });
}

function useById<T extends { id: number }>(list: T[] | undefined): Map<number, T> {
  return useMemo(() => new Map((list ?? []).map((x) => [x.id, x])), [list]);
}

/** 以 id 查找的 Map（資料尚未載入時為空 Map） */
export const useUsersById = () => useById(useUsers().data);
export const useProjectsById = () => useById(useProjects().data);
export const useStatusesById = () => useById(useStatuses().data);
