import { apiUrl } from './base.js';

/** API 錯誤：status 0 代表網路錯誤（無法連線） */
export class ApiError extends Error {
  status;
  code;
  details;
  constructor(status, code, message, details) {
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

const listeners = { unauthorized: new Set(), write: new Set(), online: new Set() };

/** 訂閱 api client 事件，回傳取消訂閱函式 */
export function onApiEvent(event, fn) {
  const set = listeners[event];
  set.add(fn);
  return () => set.delete(fn);
}

let online = true;
function setOnline(value) {
  if (online === value) return;
  online = value;
  listeners.online.forEach((fn) => fn(value));
}
export const isOnline = () => online;

/** 組 query string：略過 undefined / null / 空字串 / 空陣列；陣列以逗號連接 */
export function toQueryString(params) {
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
export async function apiFetch(method, path, body, init = {}) {
  const isGet = method === 'GET' || method === 'HEAD';
  let res;
  try {
    res = await fetch(apiUrl(path), {
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
    if (err?.name === 'AbortError') throw err;
    setOnline(false);
    throw new ApiError(0, 'NETWORK_ERROR', '無法連線到伺服器');
  }
  setOnline(true);

  const text = await res.text();
  let data = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const e = data?.error;
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
  return data;
}

export const api = {
  get: (path, init) => apiFetch('GET', path, undefined, init),
  post: (path, body) => apiFetch('POST', path, body),
  put: (path, body) => apiFetch('PUT', path, body),
  patch: (path, body) => apiFetch('PATCH', path, body),
  delete: (path) => apiFetch('DELETE', path),
};

/** 取錯誤訊息（給畫面顯示） */
export function errorMessage(err) {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '發生未知錯誤';
}
