import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GithubLink,
  GithubLinksResponse,
  ImportResult,
  IssuesResponse,
  ManualIssue,
  SyncResult,
  ManualIssueInput,
  WorktreeRecord,
  WorktreeRecordInput,
  WorktreesOverview,
} from '../../../shared/engManual.ts';
import { api } from '../../lib/api.ts';
import { LIST_POLL_MS } from '../../lib/queryClient.ts';

export const engKeys = {
  all: ['eng'] as const,
  issues: () => ['eng', 'issues'] as const,
  worktrees: () => ['eng', 'worktrees'] as const,
};

export function useIssues() {
  return useQuery({
    queryKey: engKeys.issues(),
    queryFn: ({ signal }) => api.get<IssuesResponse>('/eng/issues', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

// ── GitHub 連動（選配；githubEnabled 時前端才會呼叫） ──

/** 同步 GitHub 狀態；auto（列表載入時自動觸發）失敗不跳全域 toast */
export function useSyncIssues({ auto = false }: { auto?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: auto ? { errorToast: false } : undefined,
    mutationFn: (id?: number) => api.post<SyncResult>('/eng/issues/sync', id ? { id } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useImportIssues() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (project: string) => api.post<ImportResult>('/eng/issues/import', { project }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function usePublishIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<ManualIssue>(`/eng/issues/${id}/publish`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useSaveGithubLinks() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (links: GithubLink[]) => api.put<GithubLinksResponse>('/eng/github-links', { links }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useWorktrees() {
  return useQuery({
    queryKey: engKeys.worktrees(),
    queryFn: ({ signal }) => api.get<WorktreesOverview>('/eng/worktrees', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

/** 新增 / 編輯問題；silent 時由表單自行顯示錯誤（不發全域 toast） */
export function useSaveIssue({ silent = false }: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silent ? { errorToast: false } : undefined,
    mutationFn: ({ id, ...input }: ManualIssueInput & { id?: number }) =>
      id ? api.patch<ManualIssue>(`/eng/issues/${id}`, input) : api.post<ManualIssue>('/eng/issues', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/issues/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useSaveRecord({ silent = false }: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silent ? { errorToast: false } : undefined,
    mutationFn: ({ id, ...input }: WorktreeRecordInput & { id?: number }) =>
      id
        ? api.patch<WorktreeRecord>(`/eng/worktree-records/${id}`, input)
        : api.post<WorktreeRecord>('/eng/worktree-records', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

export function useDeleteRecord() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/worktree-records/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}
