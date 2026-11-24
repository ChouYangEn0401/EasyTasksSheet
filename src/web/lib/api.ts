import type { ApiError as ApiErrorBody } from '../../shared/common.ts';

/** API 錯誤：status 0 代表網路錯誤（無法連線） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork() {
    return this.status === 0;
  }
}

type Listeners = {
  /** 收到 401（登入請求除外） */
  unauthorized: Set<(path: string) => void>;
  /** 非 GET 請求成功（伺服器會刷新閒置計時） */
  write: Set<(path: string, method: string) => void>;
  /** 連線狀態變化：false = 網路錯誤，true = 恢復 */
  online: Set<(online: boolean) => void>;
};

const listeners: Listeners = { unauthorized: new Set(), write: new Set(), online: new Set() };

/** 訂閱 api client 事件，回傳取消訂閱函式 */
export function onApiEvent<K extends keyof Listeners>(
  event: K,
  fn: Listeners[K] extends Set<infer F> ? F : never,
): () => void {
  const set = listeners[event] as Set<typeof fn>;
  set.add(fn);
  return () => set.delete(fn);
}

let online = true;
function setOnline(value: boolean) {
  if (online === value) return;
  online = value;
  listeners.online.forEach((fn) => fn(value));
}
export const isOnline = () => online;

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

/** 組 query string：略過 undefined / null / 空字串 / 空陣列；陣列以逗號連接 */
export function toQueryString(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) sp.set(key, value.join(','));
    } else sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * 呼叫 /api。path 不含 /api 前綴（如 `/tasks`）。
 * - 非 GET 一律帶 `Content-Type: application/json`（即使無 body，後端 CSRF 檢查需要）
 * - 錯誤統一丟 ApiError；401 會通知 unauthorized 訂閱者（由 shell 導回登入頁）
 */
export async function apiFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<T> {
  const isGet = method === 'GET' || method === 'HEAD';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(!isGet && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    setOnline(false);
    throw new ApiError(0, 'NETWORK_ERROR', '無法連線到伺服器');
  }
  setOnline(true);

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const e = (data as ApiErrorBody | undefined)?.error;
    const error = new ApiError(
      res.status,
      e?.code ?? 'HTTP_ERROR',
      e?.message ?? `請求失敗（${res.status}）`,
      e?.details,
    );
    if (res.status === 401 && path !== '/auth/login') listeners.unauthorized.forEach((fn) => fn(path));
    throw error;
  }
  if (!isGet) listeners.write.forEach((fn) => fn(path, method));
  return data as T;
}

export const api = {
  get: <T>(path: string, init?: { signal?: AbortSignal }) => apiFetch<T>('GET', path, undefined, init),
  post: <T>(path: string, body?: unknown) => apiFetch<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => apiFetch<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>('PATCH', path, body),
  delete: <T>(path: string) => apiFetch<T>('DELETE', path),
};

/** 取錯誤訊息（給畫面顯示） */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '發生未知錯誤';
}
