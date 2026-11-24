import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IssuesResponse,
  Repo,
  RepoInput,
  RepoUpdateInput,
  WorktreePlan,
  WorktreePlanInput,
  WorktreePlanUpdateInput,
  WorktreesResponse,
} from '../../../shared/eng.ts';
import { api } from '../../lib/api.ts';
import { LIST_POLL_MS } from '../../lib/queryClient.ts';

export const engKeys = {
  all: ['eng'] as const,
  repos: () => ['eng', 'repos'] as const,
  issues: (repoId: number) => ['eng', 'issues', repoId] as const,
  worktrees: (repoId: number) => ['eng', 'worktrees', repoId] as const,
};

export function useRepos() {
  return useQuery({
    queryKey: engKeys.repos(),
    queryFn: ({ signal }) => api.get<Repo[]>('/eng/repos', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

/** Issue 快取（輪詢只讀快取；後端在快取過期時才向來源同步） */
export function useIssues(repoId: number | null) {
  return useQuery({
    queryKey: engKeys.issues(repoId ?? 0),
    queryFn: ({ signal }) => api.get<IssuesResponse>(`/eng/issues?repo=${repoId}`, { signal }),
    enabled: repoId != null,
    refetchInterval: LIST_POLL_MS,
  });
}

/** 手動重新整理：向來源同步 */
export function useRefreshIssues() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (repoId: number) => api.post<IssuesResponse>('/eng/issues/refresh', { repoId }),
    onSuccess: (data) => qc.setQueryData(engKeys.issues(data.repoId), data),
  });
}

export function useWorktrees(repoId: number | null) {
  return useQuery({
    queryKey: engKeys.worktrees(repoId ?? 0),
    queryFn: ({ signal }) => api.get<WorktreesResponse>(`/eng/worktrees?repo=${repoId}`, { signal }),
    enabled: repoId != null,
    refetchInterval: LIST_POLL_MS,
  });
}

/** 重新偵測（略過 server 端的短暫快取） */
export function useRedetect() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (repoId: number) => api.get<WorktreesResponse>(`/eng/worktrees?repo=${repoId}&refresh=1`),
    onSuccess: (data) => qc.setQueryData(engKeys.worktrees(data.repoId), data),
  });
}

export function useSavePlan() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...input }: WorktreePlanInput & { id?: number }) =>
      id
        ? api.patch<WorktreePlan>(`/eng/worktree-plans/${id}`, input satisfies WorktreePlanUpdateInput)
        : api.post<WorktreePlan>('/eng/worktree-plans', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng', 'worktrees'] }),
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/worktree-plans/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng', 'worktrees'] }),
  });
}

export function useSaveRepo() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...input }: RepoInput & { id?: number }) =>
      id
        ? api.patch<Repo>(`/eng/repos/${id}`, input satisfies RepoUpdateInput)
        : api.post<Repo>('/eng/repos', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/repos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}
