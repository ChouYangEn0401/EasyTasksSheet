import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { LIST_POLL_MS } from '../../lib/queryClient.js';

export const engKeys = {
  all: ['eng'],
  issues: () => ['eng', 'issues'],
  worktrees: () => ['eng', 'worktrees'],
  trash: () => ['eng', 'trash'],
  statuses: () => ['eng', 'statuses'],
};

export function useIssues() {
  return useQuery({
    queryKey: engKeys.issues(),
    queryFn: ({ signal }) => api.get('/eng/issues', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

// ── GitHub 連動（選配；githubEnabled 時前端才會呼叫） ──

/** 同步 GitHub 狀態；auto（列表載入時自動觸發）失敗不跳全域 toast */
export function useSyncIssues({ auto = false } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: auto ? { errorToast: false } : undefined,
    mutationFn: (id) => api.post('/eng/issues/sync', id ? { id } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useImportIssues() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (project) => api.post('/eng/issues/import', { project }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function usePublishIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.post(`/eng/issues/${id}/publish`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useSaveGithubLinks() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (links) => api.put('/eng/github-links', { links }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useWorktrees() {
  return useQuery({
    queryKey: engKeys.worktrees(),
    queryFn: ({ signal }) => api.get('/eng/worktrees', { signal }),
    refetchInterval: LIST_POLL_MS,
  });
}

/** 新增 / 編輯問題；silent 時由表單自行顯示錯誤（不發全域 toast） */
export function useSaveIssue({ silent = false } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silent ? { errorToast: false } : undefined,
    mutationFn: ({ id, ...input }) =>
      id ? api.patch(`/eng/issues/${id}`, input) : api.post('/eng/issues', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useDeleteIssue() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/eng/issues/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

// ── 附件與連結預覽（上傳見 uploads.ts） ──

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useRefreshPreview() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (issueId) => api.post(`/eng/issues/${issueId}/preview`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: engKeys.issues() }),
  });
}

export function useSaveRecord({ silent = false } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: silent ? { errorToast: false } : undefined,
    mutationFn: ({ id, ...input }) =>
      id ? api.patch(`/eng/worktree-records/${id}`, input) : api.post('/eng/worktree-records', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

/** 移到回收區（軟刪除） */
export function useDeleteRecord() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/eng/worktree-records/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

// ── 回收區 ──

export function useTrash(enabled) {
  return useQuery({
    queryKey: engKeys.trash(),
    queryFn: ({ signal }) => api.get('/eng/worktree-records/trash', { signal }),
    enabled,
  });
}

export function useRestoreRecord() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id) => api.post(`/eng/worktree-records/${id}/restore`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

export function usePurgeTrash() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: () => api.post('/eng/worktree-records/trash/purge', { confirm: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.all }),
  });
}

// ── 可疑回報（空清單 / 驟減）的確認 ──

export function usePendingReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, action }) => api.post(`/eng/worktrees/pending/${sourceId}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

// ── 掃描本機專案 ──

export function useScanPreview() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/eng/worktrees/scan', input),
  });
}

export function useScanApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/eng/worktrees/scan/apply', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

// ── 貼上 git worktree list 輸出（不執行 git；伺服器只解析文字） ──

export function usePastePreview() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/eng/worktrees/paste/preview', input),
  });
}

export function usePasteApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/eng/worktrees/paste/apply', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.worktrees() }),
  });
}

// ── 可自訂狀態 ──

export function useEngStatuses() {
  return useQuery({
    queryKey: engKeys.statuses(),
    queryFn: ({ signal }) => api.get('/eng/statuses', { signal }),
    staleTime: 30_000,
  });
}

export function useCreateEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/eng/statuses', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}

export function useUpdateEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }) => api.patch(`/eng/statuses/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}

export function useDeleteEngStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.delete(`/eng/statuses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: engKeys.statuses() }),
  });
}
