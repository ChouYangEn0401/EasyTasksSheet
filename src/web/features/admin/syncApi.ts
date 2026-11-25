import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SyncBulkInput,
  SyncConflictDetail,
  SyncConflictList,
  SyncResolveInput,
  SyncSource,
  SyncSourceWithToken,
} from '../../../shared/syncPush.ts';
import { api } from '../../lib/api.ts';

/** 多台電腦同步的管理 API（docs/design/sync.md） */
const KEY = ['admin', 'sync'] as const;
const SOURCES = [...KEY, 'sources'] as const;
const conflictsKey = (status: 'pending' | 'resolved') => [...KEY, 'conflicts', status] as const;

export function useSyncSources(enabled = true) {
  return useQuery({
    queryKey: SOURCES,
    queryFn: () => api.get<{ sources: SyncSource[] }>('/admin/sync/sources').then((r) => r.sources),
    enabled,
  });
}

export function useSyncConflicts(status: 'pending' | 'resolved', enabled = true) {
  return useQuery({
    queryKey: conflictsKey(status),
    queryFn: () => api.get<SyncConflictList>(`/admin/sync/conflicts?status=${status}`),
    enabled,
  });
}

export function useSyncConflict(id: number | null) {
  return useQuery({
    queryKey: [...KEY, 'conflict', id],
    queryFn: () => api.get<SyncConflictDetail>(`/admin/sync/conflicts/${id}`),
    enabled: id !== null,
    gcTime: 0,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateSource() {
  const invalidate = useInvalidate();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { name: string; autoCreateUsers: boolean }) =>
      api.post<SyncSourceWithToken>('/admin/sync/sources', input),
    // 回應含金鑰：不留在 mutation 快取
    gcTime: 0,
    onSuccess: invalidate,
  });
}

export function useUpdateSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: number;
      name?: string;
      isActive?: boolean;
      autoCreateUsers?: boolean;
    }) => api.patch<{ source: SyncSource }>(`/admin/sync/sources/${id}`, patch),
    onSuccess: invalidate,
  });
}

export function useRegenerateToken() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.post<SyncSourceWithToken>(`/admin/sync/sources/${id}/token`),
    gcTime: 0,
    onSuccess: invalidate,
  });
}

export function useDeleteSource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/admin/sync/sources/${id}`),
    onSuccess: invalidate,
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({ id, ...input }: SyncResolveInput & { id: number }) =>
      api.post<SyncConflictDetail>(`/admin/sync/conflicts/${id}/resolve`, input),
    // 套用會改動任務等資料：全部重抓
    onSuccess: () => void qc.invalidateQueries(),
  });
}

export function useResolveBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SyncBulkInput) =>
      api.post<{ resolved: number[]; skipped: number[] }>('/admin/sync/conflicts/resolve-bulk', input),
    onSuccess: () => void qc.invalidateQueries(),
  });
}
