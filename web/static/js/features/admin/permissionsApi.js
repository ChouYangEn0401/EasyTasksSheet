import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';

/** 權限設定（/api/admin/permissions，需 permissions.configure）。docs/design/permissions-config.md */
export const permissionKeys = { matrix: ['admin', 'permissions'] };

export function usePermissionMatrix(enabled = true) {
  return useQuery({
    queryKey: permissionKeys.matrix,
    queryFn: ({ signal }) => api.get('/admin/permissions', { signal }),
    enabled,
  });
}

function useApplyMatrix() {
  const qc = useQueryClient();
  return (matrix) => {
    qc.setQueryData(permissionKeys.matrix, matrix);
    void qc.invalidateQueries({ queryKey: queryKeys.me });
  };
}

export function useSavePermissions() {
  const apply = useApplyMatrix();
  return useMutation({
    // 頁面自行以 Alert 顯示失敗原因（例如受保護權限的說明）
    meta: { errorToast: false },
    mutationFn: (changes) => api.put('/admin/permissions', { changes }),
    onSuccess: apply,
  });
}

export function useResetPermissions() {
  const apply = useApplyMatrix();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (role) => api.post('/admin/permissions/reset', role ? { role } : {}),
    onSuccess: apply,
  });
}
