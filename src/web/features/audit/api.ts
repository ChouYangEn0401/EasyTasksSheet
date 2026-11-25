import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuditDetail, AuditPage, RevertResult } from '../../../shared/audit.ts';
import { api, toQueryString } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { listPollInterval } from '../../lib/sync.ts';
import { toApiParams, type AuditFilters } from './model.ts';

/** 稽核紀錄查詢鍵（皆以 'audit' 開頭；即時同步收到相關變更時整組重抓，見 lib/sync.ts） */
export const auditKeys = {
  all: ['audit'] as const,
  list: (params: Record<string, unknown>) => ['audit', 'list', params] as const,
  detail: (id: number) => ['audit', 'detail', id] as const,
  task: (taskId: number) => ['audit', 'task', taskId] as const,
};

const PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 20;

/**
 * 後台稽核頁（需 audit.view）：游標分頁。
 * focus：從某一筆開始往前看（連到「還原紀錄」或「原本的紀錄」時用）
 */
export function useAuditList(
  filters: AuditFilters,
  now: number,
  focus: number | null = null,
  enabled = true,
) {
  // 時間範圍以「當天」為單位，同一天內 queryKey 不變
  const params = toApiParams(filters, now);
  return useInfiniteQuery({
    queryKey: auditKeys.list({ ...params, focus }),
    queryFn: ({ pageParam, signal }) =>
      api.get<AuditPage>(
        `/admin/audit${toQueryString({ ...params, limit: PAGE_SIZE, before: pageParam ?? undefined })}`,
        { signal },
      ),
    initialPageParam: (focus != null ? focus + 1 : null) as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
    refetchInterval: listPollInterval,
  });
}

export function useAuditDetail(id: number | null) {
  return useQuery({
    queryKey: auditKeys.detail(id ?? 0),
    queryFn: ({ signal }) => api.get<AuditDetail>(`/admin/audit/${id}`, { signal }),
    enabled: id != null,
    staleTime: 0,
  });
}

/** 任務詳情的活動歷史（需 audit.view_task_history） */
export function useTaskHistory(taskId: number, enabled = true) {
  return useInfiniteQuery({
    queryKey: auditKeys.task(taskId),
    queryFn: ({ pageParam, signal }) =>
      api.get<AuditPage>(
        `/tasks/${taskId}/history${toQueryString({ limit: HISTORY_PAGE_SIZE, before: pageParam ?? undefined })}`,
        { signal },
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
  });
}

export function useRevert() {
  const qc = useQueryClient();
  return useMutation({
    // 衝突（409）由對話框自行顯示，不跳錯誤 toast
    meta: { errorToast: false },
    mutationFn: ({ id, force }: { id: number; force?: boolean }) =>
      api.post<RevertResult>(`/admin/audit/${id}/revert`, { force: !!force }),
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
