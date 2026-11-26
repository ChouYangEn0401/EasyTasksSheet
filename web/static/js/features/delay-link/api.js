import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { toTaskQueryString } from '../../lib/filters.js';
import { queryKeys } from '../../lib/queryClient.js';
import { listPollInterval } from '../../lib/sync.js';

/*
 * 依賴資料 hooks。查詢鍵都以 ['tasks', …] 開頭：任務的 SSE 事件（含依賴寫入時兩端任務的 update）
 * 會 invalidate queryKeys.tasks.all，詳情的依賴區與延遲鏈分頁因此即時更新。
 */

export const depKeys = {
  // 掛在任務詳情之下：任務刪除時隨詳情一併排除重抓 / 移除（lib/sync.ts）
  task: (id) => ['tasks', 'detail', id, 'deps'],
  chains: (filters, includeDone) => ['tasks', 'delay-chains', filters, includeDone],
};

export function useTaskDependencies(id, enabled = true) {
  return useQuery({
    queryKey: depKeys.task(id),
    queryFn: ({ signal }) => api.get(`/tasks/${id}/dependencies`, { signal }),
    enabled,
    refetchInterval: listPollInterval,
  });
}

export function useDelayChains(filters, includeDone) {
  const qs = toTaskQueryString(filters);
  const extra = includeDone ? `${qs ? '&' : '?'}includeDone=true` : '';
  return useQuery({
    queryKey: depKeys.chains(filters, includeDone),
    queryFn: ({ signal }) => api.get(`/tasks/delay-chains${qs}${extra}`, { signal }),
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
export function useCreateDependency(taskId) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post(`/tasks/${taskId}/dependencies`, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteDependency(taskId) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (depId) => api.delete(`/tasks/${taskId}/dependencies/${depId}`),
    onSuccess: () => invalidate(),
  });
}
