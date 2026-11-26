import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import { apiUrl } from './base.ts';

/**
 * 整站搬家包（server/app/sitepack.py、features/site_pack.py）。
 * 所有安全判斷都在後端；這裡只負責呼叫與顯示。
 */

export type SetupStatus = {
  /** 全新 server（只有一個尚未完成首次改密碼的帳號、沒有任務）：登入頁可直接還原 */
  pristine: boolean;
  /** server 本機已開啟「還原解鎖」（allow-restore），root 可在資料管理頁覆蓋已有資料 */
  restoreUnlocked: boolean;
  unlockExpiresAt: number | null;
  maxUploadMb: number;
  confirmText: string;
};

export type PackCounts = {
  users: number;
  projects: number;
  tasks: number;
  feedback_items: number;
  attachments: number;
};

export type CreatedPack = {
  id: string;
  filename: string;
  size: number;
  passphrase: string;
  manifest: { createdAt: number; createdBy: string | null; counts: PackCounts; missingAttachments: string[] };
};

export type RestoreResult = {
  ok: true;
  counts: PackCounts;
  createdAt: number;
  createdBy: string | null;
  preRestoreBackup: string | null;
};

export const setupStatusKey = ['setup-status'] as const;

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: setupStatusKey,
    queryFn: ({ signal }) => api.get<SetupStatus>('/setup/status', { signal }),
    enabled,
    staleTime: 0,
    refetchInterval: 30_000,
  });
}

export function createPack(password: string) {
  return api.post<CreatedPack>('/admin/data/pack', { password });
}

export const packDownloadUrl = (id: string) => apiUrl(`/admin/data/pack/${encodeURIComponent(id)}`);

/** 上傳搬家包（multipart，回報進度）。path 為 /setup/restore 或 /admin/data/pack/restore */
export function uploadPack(
  path: '/setup/restore' | '/admin/data/pack/restore',
  file: File,
  fields: Record<string, string>,
  onProgress?: (ratio: number) => void,
): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(path));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', '無法連線到伺服器'));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as RestoreResult);
        return;
      }
      const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      const fallback =
        xhr.status === 413
          ? '檔案太大，超過伺服器允許的上傳大小；請改在 server 上用指令匯入'
          : `請求失敗（${xhr.status}）`;
      reject(new ApiError(xhr.status, e?.code ?? 'HTTP_ERROR', e?.message ?? fallback));
    };
    xhr.send(form);
  });
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
