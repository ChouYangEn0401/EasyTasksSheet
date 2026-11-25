import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { Attachment, AttachmentLimits } from '../../../shared/engManual.ts';
import { checkFile } from './attachModel.ts';

/**
 * 附件上傳佇列（整個問題分頁共用，收合列表也不會中斷上傳）。
 * 每個檔案各自一個請求（multipart/form-data），以 XHR 取得進度、可取消、失敗可重試。
 */
export type UploadItem = {
  key: string;
  issueId: number;
  file: File;
  progress: number;
  status: 'uploading' | 'error';
  error?: string;
  /** 失敗原因可能是暫時性的（網路、伺服器錯誤）才顯示「重試」 */
  retryable?: boolean;
  /** 圖片的本機預覽（object URL；移除時釋放） */
  previewUrl?: string;
};

type Listener = () => void;

let seq = 0;

export class UploadStore {
  private items: UploadItem[] = [];
  private xhrs = new Map<string, XMLHttpRequest>();
  private listeners = new Set<Listener>();

  /** 上傳成功後呼叫（重新載入問題列表） */
  private readonly onDone: (issueId: number, attachments: Attachment[]) => void;

  constructor(onDone: (issueId: number, attachments: Attachment[]) => void = () => {}) {
    this.onDone = onDone;
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.items;

  private set(items: UploadItem[]) {
    this.items = items;
    this.listeners.forEach((fn) => fn());
  }
  private patch(key: string, patch: Partial<UploadItem>) {
    this.set(this.items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  get uploading() {
    return this.items.some((i) => i.status === 'uploading');
  }

  /** 加入並開始上傳；先在前端檢查類型 / 大小 / 數量，不合格的直接顯示失敗卡片 */
  add(issueId: number, files: File[], limits: AttachmentLimits, existing: number) {
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

  retry(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.patch(key, { status: 'uploading', progress: 0, error: undefined, retryable: undefined });
    this.start(key);
  }

  /** 取消上傳中的檔案，或移除失敗卡片 */
  remove(key: string) {
    this.xhrs.get(key)?.abort();
    this.xhrs.delete(key);
    this.drop(key);
  }

  private drop(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.set(this.items.filter((i) => i.key !== key));
  }

  private start(key: string) {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    const xhr = new XMLHttpRequest();
    this.xhrs.set(key, xhr);
    const form = new FormData();
    form.append('files', item.file, item.file.name);
    xhr.open('POST', `/api/eng/issues/${item.issueId}/attachments`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) this.patch(key, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      this.xhrs.delete(key);
      if (xhr.status >= 200 && xhr.status < 300) {
        let created: Attachment[] = [];
        try {
          created = (JSON.parse(xhr.responseText) as { attachments: Attachment[] }).attachments;
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

function errorText(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    /* 反向代理回的 HTML 等 */
  }
  if (xhr.status === 413) return '檔案過大，伺服器拒絕接收';
  if (xhr.status === 401) return '登入已逾時，請重新登入';
  return `上傳失敗（${xhr.status}）`;
}

export const UploadContext = createContext<UploadStore | null>(null);

export function useUploadStore(): UploadStore {
  const s = useContext(UploadContext);
  if (!s) throw new Error('UploadContext 未提供');
  return s;
}

export function useUploads(issueId?: number): UploadItem[] {
  const store = useUploadStore();
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return issueId == null ? items : items.filter((i) => i.issueId === issueId);
}

/** 有檔案上傳中時，離開頁面前提示 */
export function useBeforeUnloadWhileUploading(store: UploadStore) {
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (store.uploading) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [store]);
}
