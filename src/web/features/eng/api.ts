import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ManualIssue,
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
    queryFn: ({ signal }) => api.get<ManualIssue[]>('/eng/issues', { signal }),
    refetchInterval: LIST_POLL_MS,
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
