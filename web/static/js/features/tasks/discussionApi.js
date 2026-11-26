/**
 * 任務討論區的資料層（/api/tasks/:id/comments*）。查詢鍵以 ['taskComments', taskId] 開頭；
 * SSE 的 task_comment 事件由 lib/sync.ts 失效 ['taskComments'] 與任務清單 / 詳情（留言徽章）；自己寫入的回音略過。
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { listPollInterval } from '../../lib/sync.js';

export const commentKeys = {
  all: ['taskComments'],
  task: (taskId) => ['taskComments', taskId],
  threads: (taskId) => ['taskComments', taskId, 'threads'],
};

/** 討論串（新→舊分頁；以 before 游標載入更早的討論） */
export function useThreads(taskId) {
  return useInfiniteQuery({
    queryKey: commentKeys.threads(taskId),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/tasks/${taskId}/comments${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`, {
        signal,
      }),
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore ? last.nextBefore : null),
    refetchInterval: listPollInterval,
  });
}

export function fetchOlderReplies(taskId, rootId, before) {
  return api.get(`/tasks/${taskId}/comments/${rootId}/replies${before ? `?before=${before}` : ''}`);
}

/** 新留言先放進快取（避免樂觀訊息與重抓結果同時出現或短暫消失），之後再重抓校正 */
export function insertComment(data, c) {
  if (!data || data.pages.length === 0) return data;
  const exists = data.pages.some((p) =>
    p.threads.some((t) => t.id === c.id || t.replies.some((r) => r.id === c.id)),
  );
  if (exists) return data;
  if (c.parentId == null) {
    const thread = { ...c, replies: [], replyCount: 0, lastActivityAt: c.createdAt };
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, threads: [thread, ...first.threads] }, ...rest] };
  }
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      threads: p.threads.map((t) =>
        t.id === c.parentId
          ? {
              ...t,
              replies: [...t.replies, c],
              replyCount: t.replyCount + 1,
              lastActivityAt: Math.max(t.lastActivityAt, c.createdAt),
            }
          : t,
      ),
    })),
  };
}

/** 寫入後重抓此任務的討論串與任務清單（留言數徽章）；失敗由呼叫端就地顯示（不發全域 toast） */
export function useCommentMutations(taskId) {
  const qc = useQueryClient();
  // 只重抓這個任務的討論串、任務清單與詳情本身（留言數徽章）；不碰 ['tasks'] 之下的其他子資源。
  // SSE 回音由 lib/sync.ts 略過（避免一次寫入觸發兩輪重抓）
  const refreshBadges = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() }),
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId), exact: true }),
    ]);
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: commentKeys.task(taskId) }), refreshBadges()]);
  const create = useMutation({
    meta: { errorToast: false },
    mutationFn: ({ body, parentId, replyToId }) =>
      api.post(`/tasks/${taskId}/comments`, {
        body,
        ...(parentId ? { parentId } : {}),
        ...(replyToId ? { replyToId } : {}),
      }),
    onSuccess: (c) => {
      qc.setQueryData(commentKeys.threads(taskId), (d) => insertComment(d, c));
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }) => api.patch(`/tasks/${taskId}/comments/${id}`, { body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/tasks/${taskId}/comments/${id}`),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolved }) =>
      api.post(`/tasks/${taskId}/comments/${id}/${resolved ? 'resolve' : 'unresolve'}`),
    onSuccess: refresh,
  });
  const markRead = useMutation({
    meta: { errorToast: false },
    mutationFn: () => api.post(`/tasks/${taskId}/comments/read`),
    // 只影響自己的未讀徽章：重抓任務清單即可（討論串內的分隔線維持進入時的位置）
    onSuccess: refreshBadges,
  });
  return { create, update, remove, resolve, markRead };
}
