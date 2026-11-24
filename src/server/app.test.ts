import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../tests/helpers/db.ts';

const STUB_PATHS = [
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/login'],
  ['GET', '/api/users'],
  ['GET', '/api/projects'],
  ['GET', '/api/statuses'],
  ['GET', '/api/tasks'],
  ['PATCH', '/api/tasks/1'],
  ['GET', '/api/properties'],
  ['GET', '/api/overview'],
  ['GET', '/api/feedback'],
  ['DELETE', '/api/feedback/3'],
  ['GET', '/api/personal'],
  ['PUT', '/api/personal/pins/1'],
  ['GET', '/api/eng/repos'],
  ['POST', '/api/eng/worktrees/report'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users/1/unlock'],
  ['GET', '/api/changes?since=0'],
  ['GET', '/api/events'],
] as const;

describe('app', () => {
  it('GET /api/health 回 200', async () => {
    const { app } = createTestApp({ now: () => 123 });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, time: 123 });
  });

  it.each(STUB_PATHS)('%s %s 為 stub，回 501', async (method, path) => {
    const { app } = createTestApp();
    const res = await app.request(path, { method });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('未知 API 回 JSON 404', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '找不到 API' } });
  });
});
