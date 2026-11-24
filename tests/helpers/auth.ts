import type { App } from '../../src/server/app.ts';
import { TEST_PASSWORD } from './db.ts';

export type Client = {
  /** 送出 JSON 請求（自動帶 cookie、Content-Type 與同源 Origin） */
  request: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  get: (path: string) => Promise<Response>;
  cookie: string;
};

/** 以 cookie 包裝 app.request 的測試用 client；cookie 為空字串時即未登入 */
export function client(app: App, cookie = ''): Client {
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie && { cookie }),
        ...(method !== 'GET' && { 'content-type': 'application/json', origin: 'http://localhost' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { request, get: (path) => request('GET', path), cookie };
}

/** 呼叫 POST /api/auth/login，回傳原始回應 */
export function login(
  app: App,
  username: string,
  password = TEST_PASSWORD,
  headers: Record<string, string> = {},
) {
  return client(app).request('POST', '/api/auth/login', { username, password }, headers);
}

/** 登入並回傳已帶 session cookie 的 client；登入失敗即拋錯 */
export async function loginAs(app: App, user: { username: string; password?: string }): Promise<Client> {
  const res = await login(app, user.username, user.password ?? TEST_PASSWORD);
  if (res.status !== 200) throw new Error(`登入失敗：${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return client(app, setCookie.split(';')[0]!);
}
