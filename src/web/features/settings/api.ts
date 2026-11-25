import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import type { Profile, ProfilePatch } from './model.ts';

export const profileKey = ['profile'] as const;

export function useProfile() {
  return useQuery({
    queryKey: profileKey,
    queryFn: ({ signal }) => api.get<Profile>('/profile', { signal }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    // 表單自行顯示欄位錯誤，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (patch: ProfilePatch) => api.patch<Profile>('/profile', patch),
    onSuccess: (profile) => {
      qc.setQueryData(profileKey, profile);
      // 名稱 / 帳號變了：頂欄使用者與成員清單重抓
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      void qc.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}
