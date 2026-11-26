import { createContext, useContext, useEffect, useSyncExternalStore } from 'preact/compat';

import { checkFile } from './attachModel.js';
import { apiUrl } from '../../lib/base.js';

/**
 * 附件上傳佇列（整個問題分頁共用，收合列表也不會中斷上傳）。
 * 每個檔案各自一個請求（multipart/form-data），以 XHR 取得進度、可取消、失敗可重試。
 */

let seq = 0;

export class UploadStore {
  items = [];
  xhrs = new Map();
  listeners = new Set();

  /** 上傳成功後呼叫（重新載入問題列表） */
  onDone;

  constructor(onDone = () => {}) {
    this.onDone = onDone;
  }

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.items;

  set(items) {
    this.items = items;
    this.listeners.forEach((fn) => fn());
  }
  patch(key, patch) {
    this.set(this.items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  get uploading() {
    return this.items.some((i) => i.status === 'uploading');
  }

  /** 加入並開始上傳；先在前端檢查類型 / 大小 / 數量，不合格的直接顯示失敗卡片 */
  add(issueId, files, limits, existing) {
    let count = existing + this.items.filter((i) => i.issueId === issueId).length;
    for (const file of files) {
      const key = `u${++seq}`;
      let error = checkFile(file, limits);
      if (!error && count >= limits.maxFiles) error = `每筆問題最多 ${limits.maxFiles} 個附件`;
      if (!error) count++;
      const previewUrl =
        file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : undefined;
      this.set([
        ...this.items,
        {
          key,
          issueId,
          file,
          progress: 0,
          status: error ? 'error' : 'uploading',
          error: error ?? undefined,
          previewUrl,
        },
      ]);
      if (!error) this.start(key);
    }
  }

  retry(key) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.patch(key, { status: 'uploading', progress: 0, error: undefined, retryable: undefined });
    this.start(key);
  }

  /** 取消上傳中的檔案，或移除失敗卡片 */
  remove(key) {
    this.xhrs.get(key)?.abort();
    this.xhrs.delete(key);
    this.drop(key);
  }

  drop(key) {
    const item = this.items.find((i) => i.key === key);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.set(this.items.filter((i) => i.key !== key));
  }

  start(key) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    const xhr = new XMLHttpRequest();
    this.xhrs.set(key, xhr);
    const form = new FormData();
    form.append('files', item.file, item.file.name);
    xhr.open('POST', apiUrl(`/eng/issues/${item.issueId}/attachments`));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) this.patch(key, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      this.xhrs.delete(key);
      if (xhr.status >= 200 && xhr.status < 300) {
        let created = [];
        try {
          created = JSON.parse(xhr.responseText).attachments;
        } catch {
          /* 忽略 */
        }
        this.drop(key);
        this.onDone(item.issueId, created);
      } else {
        // 4xx 是內容 / 數量問題，重試沒有意義（401 登入逾時、408 / 429 除外）
        const retryable = xhr.status >= 500 || [0, 401, 408, 429].includes(xhr.status);
        this.patch(key, { status: 'error', error: errorText(xhr), retryable });
      }
    };
    xhr.onerror = () => {
      this.xhrs.delete(key);
      this.patch(key, { status: 'error', error: '無法連線到伺服器', retryable: true });
    };
    xhr.send(form);
  }
}

function errorText(xhr) {
  try {
    const body = JSON.parse(xhr.responseText);
    if (body.error?.message) return body.error.message;
  } catch {
    /* 反向代理回的 HTML 等 */
  }
  if (xhr.status === 413) return '檔案過大，伺服器拒絕接收';
  if (xhr.status === 401) return '登入已逾時，請重新登入';
  return `上傳失敗（${xhr.status}）`;
}

export const UploadContext = createContext(null);

export function useUploadStore() {
  const s = useContext(UploadContext);
  if (!s) throw new Error('UploadContext 未提供');
  return s;
}

export function useUploads(issueId) {
  const store = useUploadStore();
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return issueId == null ? items : items.filter((i) => i.issueId === issueId);
}

/** 有檔案上傳中時，離開頁面前提示 */
export function useBeforeUnloadWhileUploading(store) {
  useEffect(() => {
    const onBefore = (e) => {
      if (store.uploading) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [store]);
}
