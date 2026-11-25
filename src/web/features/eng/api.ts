import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EngStatus,
  EngStatusesResponse,
  EngStatusInput,
  EngStatusKind,
  ScanApplyResult,
  ScanPreview,
  WorktreeTrash,
  GithubLink,
  GithubLinksResponse,
  ImportResult,
  IssuesResponse,
  LinkPreview,
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
  trash: () => ['eng', 'trash'] as const,
  statuses: () => ['eng', 'statuses'] as const,
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

// ── 附件與連結預覽（上傳見 uploads.ts） ──

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useRefreshPreview() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (issueId: number) => api.post<{ preview: LinkPreview }>(`/eng/issues/${issueId}/preview`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
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

/** 移到回收區（軟刪除） */
export function useDeleteRecord() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/worktree-records/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

// ── 回收區 ──

export function useTrash(enabled: boolean) {
  return useQuery({
    queryKey: engKeys.trash(),
    queryFn: ({ signal }) => api.get<WorktreeTrash>('/eng/worktree-records/trash', { signal }),
    enabled,
  });
}

export function useRestoreRecord() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: number) => api.post<WorktreeRecord>(`/eng/worktree-records/${id}/restore`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

export function usePurgeTrash() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      api.post<{ ok: true; purged: number }>('/eng/worktree-records/trash/purge', { confirm: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

// ── 可疑回報（空清單 / 驟減）的確認 ──

export function usePendingReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, action }: { sourceId: number; action: 'accept' | 'discard' }) =>
      api.post<{ ok: true }>(`/eng/worktrees/pending/${sourceId}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

// ── 掃描本機專案 ──

export function useScanPreview() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { path: string; machine?: string }) =>
      api.post<ScanPreview>('/eng/worktrees/scan', input),
  });
}

export function useScanApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { path: string; machine?: string; paths: string[] }) =>
      api.post<ScanApplyResult>('/eng/worktrees/scan/apply', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

// ── 可自訂狀態 ──

export function useEngStatuses() {
  return useQuery({
    queryKey: engKeys.statuses(),
    queryFn: ({ signal }) => api.get<EngStatusesResponse>('/eng/statuses', { signal }),
    staleTime: 30_000,
  });
}

export function useCreateEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: EngStatusInput & { kind: EngStatusKind; label: string }) =>
      api.post<EngStatus>('/eng/statuses', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}

export function useUpdateEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: EngStatusInput & { id: number }) =>
      api.patch<EngStatus>(`/eng/statuses/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}

export function useDeleteEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/eng/statuses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}
