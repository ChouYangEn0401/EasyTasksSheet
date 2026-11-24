import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleError, notFound } from './errors.ts';
import { readJson } from './validate.ts';

function makeApp() {
  const app = new Hono();
  app.get('/http', () => {
    throw notFound('任務不存在');
  });
  app.post('/zod', async (c) => c.json(await readJson(c, z.object({ title: z.string().min(1) }))));
  app.get('/boom', () => {
    throw new Error('secret detail');
  });
  app.onError(handleError);
  return app;
}

describe('統一錯誤處理', () => {
  it('HttpError 轉為對應狀態與格式', async () => {
    const res = await makeApp().request('/http');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '任務不存在' } });
  });

  it('Zod 驗證失敗回 400 VALIDATION_ERROR', async () => {
    const res = await makeApp().request('/zod', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('非 JSON body 回 400 BAD_REQUEST', async () => {
    const res = await makeApp().request('/zod', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_REQUEST');
  });

  it('未預期錯誤回 500 且不洩漏細節', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await makeApp().request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '伺服器發生錯誤' } });
    spy.mockRestore();
  });
});
