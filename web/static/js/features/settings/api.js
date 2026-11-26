import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryClient.js';

export const profileKey = ['profile'];

export function useProfile() {
  return useQuery({
    queryKey: profileKey,
    queryFn: ({ signal }) => api.get('/profile', { signal }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    // 表單自行顯示欄位錯誤，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (patch) => api.patch('/profile', patch),
    onSuccess: (profile) => {
      qc.setQueryData(profileKey, profile);
      // 名稱 / 帳號變了：頂欄使用者與成員清單重抓
      void qc.invalidateQueries({ queryKey: queryKeys.me });
      void qc.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}
