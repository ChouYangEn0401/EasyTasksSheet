import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedbackCreateInput, FeedbackItem, FeedbackUpdateInput } from '../../../shared/feedback.ts';
import { api } from '../../lib/api.ts';
import { LIST_POLL_MS } from '../../lib/queryClient.ts';
import { recordFeedbackCreate } from '../undo/simpleUndo.ts';
import { applyPatch } from './model.ts';

export const feedbackKeys = {
  all: ['feedback'] as const,
  list: () => ['feedback', 'list'] as const,
};

/** 全部問題 / 回饋（篩選在前端進行，清單與月曆共用同一份資料） */
export function useFeedbackItems() {
  return useQuery({
    queryKey: feedbackKeys.list(),
    queryFn: ({ signal }) => api.get<FeedbackItem[]>('/feedback', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

export function useCreateFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input: FeedbackCreateInput) => api.post<FeedbackItem>('/feedback', input),
    onSuccess: (item, input) => {
      qc.setQueryData<FeedbackItem[]>(feedbackKeys.list(), (prev) => (prev ? [item, ...prev] : [item]));
      recordFeedbackCreate(qc, feedbackKeys.list(), item, input);
      return qc.invalidateQueries({ queryKey: feedbackKeys.all });
    },
  });
}

export type FeedbackPatch = FeedbackUpdateInput & { id: number };

/** PATCH：樂觀更新，失敗時還原（錯誤由呼叫端顯示） */
export function useUpdateFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...patch }: FeedbackPatch) => api.patch<FeedbackItem>(`/feedback/${id}`, patch),
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: feedbackKeys.list() });
      const prev = qc.getQueryData<FeedbackItem[]>(feedbackKeys.list());
      qc.setQueryData<FeedbackItem[]>(feedbackKeys.list(), (list) =>
        list?.map((i) => (i.id === id ? applyPatch(i, patch) : i)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(feedbackKeys.list(), ctx.prev);
    },
    onSuccess: (item) => {
      qc.setQueryData<FeedbackItem[]>(feedbackKeys.list(), (list) =>
        list?.map((i) => (i.id === item.id ? item : i)),
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: feedbackKeys.all }),
  });
}

export function useDeleteFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/feedback/${id}`),
    onSuccess: (_res, id) => {
      qc.setQueryData<FeedbackItem[]>(feedbackKeys.list(), (list) => list?.filter((i) => i.id !== id));
      return qc.invalidateQueries({ queryKey: feedbackKeys.all });
    },
  });
}
