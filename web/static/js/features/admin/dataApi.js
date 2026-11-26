import { useMutation, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { apiUrl } from '../../lib/base.js';

/** 下載端點（瀏覽器直接以 <a download> 取得附件） */
export const DATA_EXPORT_URL = apiUrl('/admin/data/export');
export const DATA_BACKUP_URL = apiUrl('/admin/data/backup');

/** 觸發瀏覽器下載（同源 GET，帶 session cookie） */
export function startDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useImportPreview() {
  return useMutation({
    // 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (doc) => api.post('/admin/data/import/preview', doc),
    gcTime: 0,
  });
}

export function useImportApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/admin/data/import/apply', input),
    // 結果含臨時密碼：不留在 mutation 快取
    gcTime: 0,
    // 匯入可能改動任何資料：全部重抓
    onSuccess: () => void qc.invalidateQueries(),
  });
}
