import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onApiEvent, toQueryString } from './api.ts';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('POST 無 body 仍帶 Content-Type: application/json', async () => {
    const fetch = mockFetch(200, { ok: true });
    await api.post('/auth/heartbeat');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/auth/heartbeat');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBeUndefined();
  });

  it('GET 不帶 Content-Type', async () => {
    const fetch = mockFetch(200, []);
    await api.get('/tasks');
    expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('錯誤回應轉為 ApiError，401 通知訂閱者（登入請求除外）', async () => {
    mockFetch(401, { error: { code: 'UNAUTHORIZED', message: '請先登入' } });
    const onUnauthorized = vi.fn();
    const off = onApiEvent('unauthorized', onUnauthorized);
    await expect(api.get('/tasks')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: '請先登入',
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(api.post('/auth/login', {})).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    off();
  });

  it('寫入成功通知 write 訂閱者；網路錯誤為 status 0', async () => {
    mockFetch(201, { id: 1 });
    const onWrite = vi.fn();
    const off = onApiEvent('write', onWrite);
    await api.post('/tasks', { title: 'a' });
    expect(onWrite).toHaveBeenCalledWith('/tasks', 'POST');
    off();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await api.get('/tasks').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isNetwork).toBe(true);
  });

  it('toQueryString', () => {
    expect(toQueryString({ a: undefined, b: '', c: [], d: [1, 2], e: 'x y' })).toBe('?d=1%2C2&e=x+y');
    expect(toQueryString({})).toBe('');
  });
});
