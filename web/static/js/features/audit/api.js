import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api, toQueryString } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';
import { listPollInterval } from '../../lib/sync.js';
import { toApiParams } from './model.js';

/** 稽核紀錄查詢鍵（皆以 'audit' 開頭；即時同步收到相關變更時整組重抓，見 lib/sync.ts） */
export const auditKeys = {
  all: ['audit'],
  list: (params) => ['audit', 'list', params],
  detail: (id) => ['audit', 'detail', id],
  task: (taskId) => ['audit', 'task', taskId],
};

const PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 20;

/**
 * 後台稽核頁（需 audit.view）：游標分頁。
 * focus：從某一筆開始往前看（連到「還原紀錄」或「原本的紀錄」時用）
 */
export function useAuditList(filters, now, focus = null, enabled = true) {
  // 時間範圍以「當天」為單位，同一天內 queryKey 不變
  const params = toApiParams(filters, now);
  return useInfiniteQuery({
    queryKey: auditKeys.list({ ...params, focus }),
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/admin/audit${toQueryString({ ...params, limit: PAGE_SIZE, before: pageParam ?? undefined })}`,
        { signal },
      ),
    initialPageParam: focus != null ? focus + 1 : null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
    refetchInterval: listPollInterval,
  });
}

export function useAuditDetail(id) {
  return useQuery({
    queryKey: auditKeys.detail(id ?? 0),
    queryFn: ({ signal }) => api.get(`/admin/audit/${id}`, { signal }),
    enabled: id != null,
    staleTime: 0,
  });
}

/** 任務詳情的活動歷史（需 audit.view_task_history） */
export function useTaskHistory(taskId, enabled = true) {
  return useInfiniteQuery({
    queryKey: auditKeys.task(taskId),
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `/tasks/${taskId}/history${toQueryString({ limit: HISTORY_PAGE_SIZE, before: pageParam ?? undefined })}`,
        { signal },
      ),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
  });
}

export function useRevert() {
  const qc = useQueryClient();
  return useMutation({
    // 衝突（409）由對話框自行顯示，不跳錯誤 toast
    meta: { errorToast: false },
    mutationFn: ({ id, force }) => api.post(`/admin/audit/${id}/revert`, { force: !!force }),
    onSettled: () => {
      for (const key of [
        auditKeys.all,
        queryKeys.tasks.all,
        queryKeys.projects,
        queryKeys.statuses,
        queryKeys.properties,
        queryKeys.users,
        ['admin'],
        queryKeys.me,
      ])
        void qc.invalidateQueries({ queryKey: key });
    },
  });
}
