import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DelayChainsResponse,
  DependencyCreateInput,
  DependencyMutationResult,
  DependencyRemoved,
  TaskDependencies,
} from '../../../shared/dependencies.ts';
import { api } from '../../lib/api.ts';
import { toTaskQueryString, type TaskFilters } from '../../lib/filters.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { listPollInterval } from '../../lib/sync.ts';

/*
 * 依賴資料 hooks。查詢鍵都以 ['tasks', …] 開頭：任務的 SSE 事件（含依賴寫入時兩端任務的 update）
 * 會 invalidate queryKeys.tasks.all，詳情的依賴區與延遲鏈分頁因此即時更新。
 */

export const depKeys = {
  // 掛在任務詳情之下：任務刪除時隨詳情一併排除重抓 / 移除（lib/sync.ts）
  task: (id: number) => ['tasks', 'detail', id, 'deps'] as const,
  chains: (filters: TaskFilters, includeDone: boolean) =>
    ['tasks', 'delay-chains', filters, includeDone] as const,
};

export function useTaskDependencies(id: number, enabled = true) {
  return useQuery({
    queryKey: depKeys.task(id),
    queryFn: ({ signal }) => api.get<TaskDependencies>(`/tasks/${id}/dependencies`, { signal }),
    enabled,
    refetchInterval: listPollInterval,
  });
}

export function useDelayChains(filters: TaskFilters, includeDone: boolean) {
  const qs = toTaskQueryString(filters);
  const extra = includeDone ? `${qs ? '&' : '?'}includeDone=true` : '';
  return useQuery({
    queryKey: depKeys.chains(filters, includeDone),
    queryFn: ({ signal }) => api.get<DelayChainsResponse>(`/tasks/delay-chains${qs}${extra}`, { signal }),
    refetchInterval: listPollInterval,
    placeholderData: (prev) => prev,
  });
}

/** 寫入後重抓所有任務相關查詢（看板 / 清單的依賴欄位、兩端的依賴區、延遲鏈） */
function useInvalidateTasks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
}

/** 建立依賴；失敗（例如循環 409）由呼叫端顯示訊息，不發全域 toast */
export function useCreateDependency(taskId: number) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: DependencyCreateInput) =>
      api.post<DependencyMutationResult>(`/tasks/${taskId}/dependencies`, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateDependency(taskId: number) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ depId, ...patch }: { depId: number; lagDays?: number; note?: string }) =>
      api.patch<DependencyMutationResult>(`/tasks/${taskId}/dependencies/${depId}`, patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteDependency(taskId: number) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (depId: number) => api.delete<DependencyRemoved>(`/tasks/${taskId}/dependencies/${depId}`),
    onSuccess: () => invalidate(),
  });
}
