import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigurableRole, PermissionChange, PermissionMatrix } from '../../../shared/permissions.ts';
import { api } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';

/** 權限設定（/api/admin/permissions，需 permissions.configure）。docs/design/permissions-config.md */
export const permissionKeys = { matrix: ['admin', 'permissions'] as const };

export function usePermissionMatrix(enabled = true) {
  return useQuery({
    queryKey: permissionKeys.matrix,
    queryFn: ({ signal }) => api.get<PermissionMatrix>('/admin/permissions', { signal }),
    enabled,
  });
}

function useApplyMatrix() {
  const qc = useQueryClient();
  return (matrix: PermissionMatrix) => {
    qc.setQueryData(permissionKeys.matrix, matrix);
    void qc.invalidateQueries({ queryKey: queryKeys.me });
  };
}

export function useSavePermissions() {
  const apply = useApplyMatrix();
  return useMutation({
    // 頁面自行以 Alert 顯示失敗原因（例如受保護權限的說明）
    meta: { errorToast: false },
    mutationFn: (changes: PermissionChange[]) => api.put<PermissionMatrix>('/admin/permissions', { changes }),
    onSuccess: apply,
  });
}

export function useResetPermissions() {
  const apply = useApplyMatrix();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (role?: ConfigurableRole) =>
      api.post<PermissionMatrix>('/admin/permissions/reset', role ? { role } : {}),
    onSuccess: apply,
  });
}
