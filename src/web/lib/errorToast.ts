import { ApiError } from './api.ts';
import { toast, type ToastInput } from './toast.ts';

const REVERTED = '已還原為先前的內容。';

/**
 * 寫入失敗的 toast 內容（docs/design/realtime-feedback.md §2 文案表）。
 * 回傳 null 代表不需顯示（401 由 session 處理導回登入頁、使用者取消）。
 */
export function errorToastInput(err: unknown, retry?: () => Promise<unknown>): ToastInput | null {
  if ((err as Error)?.name === 'AbortError') return null;
  const action = retry ? { label: '重試', onClick: retry } : undefined;
  if (err instanceof ApiError) {
    if (err.status === 401) return null;
    if (err.isNetwork)
      return { tone: 'danger', title: '連線中斷，變更未送出', description: REVERTED, action };
    if (err.status === 400) return { tone: 'danger', title: '內容格式不正確', description: err.message };
    if (err.status === 403) return { tone: 'danger', title: '沒有權限執行此操作' };
    if (err.status === 404) return { tone: 'danger', title: '此項目已被刪除', description: '清單已更新。' };
  }
  return { tone: 'danger', title: '無法儲存變更', description: REVERTED, action };
}

/** 顯示寫入失敗 toast（retry 以相同參數重送） */
export function notifyError(err: unknown, retry?: () => Promise<unknown>): void {
  const input = errorToastInput(err, retry);
  if (input) toast(input);
}

/** mutation meta：errorToast = false 時不發全域失敗 toast（表單對話框自行顯示錯誤） */
export type MutationToastMeta = { errorToast?: boolean };
