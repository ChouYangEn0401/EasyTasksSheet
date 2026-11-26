/**
 * 相關任務與複製任務的資料層。查詢鍵在 ['tasks', ...] 之下，
 * 因此任何任務變更（含他人經 SSE 傳來的 task update）都會讓關聯清單重抓（lib/sync.ts）。
 */
import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { listPollInterval } from '../../lib/sync.js';

export const relationKeys = {
  // 掛在任務詳情之下：任務刪除時隨詳情一併排除重抓 / 移除（lib/sync.ts）
  of: (taskId) => [...queryKeys.tasks.detail(taskId), 'relations'],
  search: (q) => [...queryKeys.tasks.all, 'relation-search', q],
};

export function useTaskRelations(taskId, enabled = true) {
  return useQuery({
    queryKey: relationKeys.of(taskId),
    queryFn: ({ signal }) => api.get(`/tasks/${taskId}/relations`, { signal }),
    enabled,
    refetchInterval: listPollInterval,
  });
}

/** 搜尋選單：以標題關鍵字查詢（空字串不查） */
export function useRelationSearch(q) {
  const query = q.trim();
  return useQuery({
    queryKey: relationKeys.search(query),
    queryFn: ({ signal }) => api.get(`/tasks?q=${encodeURIComponent(query)}`, { signal }),
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
}

function invalidateAfterRelation(qc, ids) {
  return Promise.all([
    ...ids.map((id) => qc.invalidateQueries({ queryKey: relationKeys.of(id) })),
    qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
  ]);
}

export function useAddRelation(taskId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input) => api.post(`/tasks/${taskId}/relations`, { type: 'related', ...input }),
    onSuccess: (rel) => {
      qc.setQueryData(relationKeys.of(taskId), (prev) =>
        prev && !prev.some((r) => r.id === rel.id) ? [...prev, rel] : prev,
      );
      return invalidateAfterRelation(qc, [taskId, rel.task.id]);
    },
  });
}

export function useRemoveRelation(taskId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rel) => api.delete(`/tasks/${taskId}/relations/${rel.id}`),
    onMutate: async (rel) => {
      await qc.cancelQueries({ queryKey: relationKeys.of(taskId) });
      const prev = qc.getQueryData(relationKeys.of(taskId));
      qc.setQueryData(relationKeys.of(taskId), (list) => list?.filter((r) => r.id !== rel.id));
      return { prev };
    },
    onError: (_err, _rel, ctx) => {
      if (ctx?.prev) qc.setQueryData(relationKeys.of(taskId), ctx.prev);
    },
    onSettled: (_r, _e, rel) => invalidateAfterRelation(qc, [taskId, rel.task.id]),
  });
}

export function useDuplicateTask(taskId) {
  const qc = useQueryClient();
  return useMutation({
    // 對話框自行顯示錯誤
    meta: { errorToast: false },
    mutationFn: (input) => api.post(`/tasks/${taskId}/duplicate`, input),
    onSuccess: (task) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      return Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
        qc.invalidateQueries({ queryKey: relationKeys.of(taskId) }),
      ]);
    },
  });
}
