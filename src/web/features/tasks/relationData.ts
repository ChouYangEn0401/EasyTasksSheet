/**
 * 相關任務與複製任務的資料層。查詢鍵在 ['tasks', ...] 之下，
 * 因此任何任務變更（含他人經 SSE 傳來的 task update）都會讓關聯清單重抓（lib/sync.ts）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Task } from '../../../shared/tasks.ts';
import type {
  TaskDuplicateInput,
  TaskRelation,
  TaskRelationCreateInput,
} from '../../../shared/taskRelations.ts';
import { api } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { listPollInterval } from '../../lib/sync.ts';

export const relationKeys = {
  // 掛在任務詳情之下：任務刪除時隨詳情一併排除重抓 / 移除（lib/sync.ts）
  of: (taskId: number) => [...queryKeys.tasks.detail(taskId), 'relations'] as const,
  search: (q: string) => [...queryKeys.tasks.all, 'relation-search', q] as const,
};

export function useTaskRelations(taskId: number, enabled = true) {
  return useQuery({
    queryKey: relationKeys.of(taskId),
    queryFn: ({ signal }) => api.get<TaskRelation[]>(`/tasks/${taskId}/relations`, { signal }),
    enabled,
    refetchInterval: listPollInterval,
  });
}

/** 搜尋選單：以標題關鍵字查詢（空字串不查） */
export function useRelationSearch(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: relationKeys.search(query),
    queryFn: ({ signal }) => api.get<Task[]>(`/tasks?q=${encodeURIComponent(query)}`, { signal }),
    enabled: query.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
}

function invalidateAfterRelation(qc: ReturnType<typeof useQueryClient>, ids: number[]) {
  return Promise.all([
    ...ids.map((id) => qc.invalidateQueries({ queryKey: relationKeys.of(id) })),
    qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
  ]);
}

export function useAddRelation(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskRelationCreateInput) =>
      api.post<TaskRelation>(`/tasks/${taskId}/relations`, { type: 'related', ...input }),
    onSuccess: (rel) => {
      qc.setQueryData<TaskRelation[]>(relationKeys.of(taskId), (prev) =>
        prev && !prev.some((r) => r.id === rel.id) ? [...prev, rel] : prev,
      );
      return invalidateAfterRelation(qc, [taskId, rel.task.id]);
    },
  });
}

export function useRemoveRelation(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rel: TaskRelation) => api.delete<{ ok: true }>(`/tasks/${taskId}/relations/${rel.id}`),
    onMutate: async (rel) => {
      await qc.cancelQueries({ queryKey: relationKeys.of(taskId) });
      const prev = qc.getQueryData<TaskRelation[]>(relationKeys.of(taskId));
      qc.setQueryData<TaskRelation[]>(relationKeys.of(taskId), (list) =>
        list?.filter((r) => r.id !== rel.id),
      );
      return { prev };
    },
    onError: (_err, _rel, ctx) => {
      if (ctx?.prev) qc.setQueryData(relationKeys.of(taskId), ctx.prev);
    },
    onSettled: (_r, _e, rel) => invalidateAfterRelation(qc, [taskId, rel.task.id]),
  });
}

export function useDuplicateTask(taskId: number) {
  const qc = useQueryClient();
  return useMutation({
    // 對話框自行顯示錯誤
    meta: { errorToast: false },
    mutationFn: (input: TaskDuplicateInput) => api.post<Task>(`/tasks/${taskId}/duplicate`, input),
    onSuccess: (task) => {
      qc.setQueryData(queryKeys.tasks.detail(task.id), task);
      return Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
        qc.invalidateQueries({ queryKey: relationKeys.of(taskId) }),
      ]);
    },
  });
}
