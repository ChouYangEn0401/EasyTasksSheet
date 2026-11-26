import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { LIST_POLL_MS } from '../../lib/queryClient.js';
import { recordFeedbackCreate } from '../undo/simpleUndo.js';
import { applyPatch } from './model.js';

export const feedbackKeys = {
  all: ['feedback'],
  list: () => ['feedback', 'list'],
};

/** 全部問題 / 回饋（篩選在前端進行，清單與月曆共用同一份資料） */
export function useFeedbackItems() {
  return useQuery({
    queryKey: feedbackKeys.list(),
    queryFn: ({ signal }) => api.get('/feedback', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

export function useCreateFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/feedback', input),
    onSuccess: (item, input) => {
      qc.setQueryData(feedbackKeys.list(), (prev) => (prev ? [item, ...prev] : [item]));
      recordFeedbackCreate(qc, feedbackKeys.list(), item, input);
      return qc.invalidateQueries({ queryKey: feedbackKeys.all });
    },
  });
}

/** PATCH：樂觀更新，失敗時還原（錯誤由呼叫端顯示） */
export function useUpdateFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...patch }) => api.patch(`/feedback/${id}`, patch),
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: feedbackKeys.list() });
      const prev = qc.getQueryData(feedbackKeys.list());
      qc.setQueryData(feedbackKeys.list(), (list) =>
        list?.map((i) => (i.id === id ? applyPatch(i, patch) : i)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(feedbackKeys.list(), ctx.prev);
    },
    onSuccess: (item) => {
      qc.setQueryData(feedbackKeys.list(), (list) => list?.map((i) => (i.id === item.id ? item : i)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: feedbackKeys.all }),
  });
}

export function useDeleteFeedback() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/feedback/${id}`),
    onSuccess: (_res, id) => {
      qc.setQueryData(feedbackKeys.list(), (list) => list?.filter((i) => i.id !== id));
      return qc.invalidateQueries({ queryKey: feedbackKeys.all });
    },
  });
}
