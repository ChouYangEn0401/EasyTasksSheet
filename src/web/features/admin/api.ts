import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminTempPasswordResponse,
  AdminUser,
  AdminUserCreateInput,
  AdminUserUpdateInput,
} from '../../../shared/admin.ts';
import { api } from '../../lib/api.ts';
import { LIST_POLL_MS, queryKeys } from '../../lib/queryClient.ts';

export const adminKeys = { users: ['admin', 'users'] as const };

/** 成員管理清單（含停用者與鎖定狀態） */
export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: adminKeys.users,
    queryFn: ({ signal }) => api.get<AdminUser[]>('/admin/users', { signal }),
    refetchInterval: LIST_POLL_MS,
    enabled,
  });
}

/** 以伺服器回傳的成員資料更新清單快取，並讓共用 users / me 重抓（名稱、角色可能變了） */
function useApplyUser() {
  const qc = useQueryClient();
  return (user: AdminUser) => {
    qc.setQueryData<AdminUser[]>(adminKeys.users, (list) =>
      list
        ? list.some((u) => u.id === user.id)
          ? list.map((u) => (u.id === user.id ? user : u))
          : [...list, user]
        : list,
    );
    void qc.invalidateQueries({ queryKey: queryKeys.users });
    void qc.invalidateQueries({ queryKey: queryKeys.me });
  };
}

/*
 * 回傳臨時密碼的兩個 mutation 設 gcTime: 0：結果只交給呼叫端放進元件 state，
 * 不寫入 query 快取，元件卸載後 mutation 快取也立即清除。
 */

export function useCreateAdminUser() {
  const apply = useApplyUser();
  return useMutation({
    mutationFn: (input: AdminUserCreateInput) => api.post<AdminTempPasswordResponse>('/admin/users', input),
    onSuccess: (res) => apply(res.user),
    gcTime: 0,
  });
}

export function useResetPassword() {
  const apply = useApplyUser();
  return useMutation({
    mutationFn: (id: number) => api.post<AdminTempPasswordResponse>(`/admin/users/${id}/reset-password`),
    onSuccess: (res) => apply(res.user),
    gcTime: 0,
  });
}

export function useUpdateAdminUser() {
  const apply = useApplyUser();
  return useMutation({
    mutationFn: ({ id, ...patch }: AdminUserUpdateInput & { id: number }) =>
      api.patch<AdminUser>(`/admin/users/${id}`, patch),
    onSuccess: apply,
  });
}

export function useUnlockUser() {
  const apply = useApplyUser();
  return useMutation({
    mutationFn: (id: number) => api.post<AdminUser>(`/admin/users/${id}/unlock`),
    onSuccess: apply,
  });
}
