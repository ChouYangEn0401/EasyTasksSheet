import { describe, expect, it } from 'vitest';
import { client, loginAs } from '../../tests/helpers/auth.ts';
import { createTestApp, createTestUser } from '../../tests/helpers/db.ts';

const STUB_PATHS = [
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

const PROTECTED_PATHS = [
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/heartbeat'],
  ['POST', '/api/auth/password'],
  ['GET', '/api/users'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/statuses'],
  ['GET', '/api/tasks'],
  ['PATCH', '/api/tasks/1'],
  ['DELETE', '/api/tasks/1'],
  ['GET', '/api/properties'],
  ['GET', '/api/nope'],
  ...STUB_PATHS,
] as const;

async function loggedIn() {
  const { app, db } = createTestApp();
  const user = await createTestUser(db);
  return loginAs(app, user);
}

describe('app', () => {
  it('GET /api/health 回 200（不需登入）', async () => {
    const { app } = createTestApp({ now: () => 123 });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, time: 123 });
  });

  it.each(PROTECTED_PATHS)('未登入 %s %s 回 401', async (method, path) => {
    const { app } = createTestApp();
    const res = await client(app).request(
      method,
      path,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  it.each(STUB_PATHS)('%s %s 為 stub，登入後回 501', async (method, path) => {
    const api = await loggedIn();
    const res = await api.request(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('NOT_IMPLEMENTED');
  });

  it('未知 API 回 JSON 404', async () => {
    const api = await loggedIn();
    const res = await api.get('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '找不到 API' } });
  });
});
