import { describe, expect, it } from 'vitest';
import { client, loginAs } from '../../tests/helpers/auth.ts';
import { createTestApp, createTestUser } from '../../tests/helpers/db.ts';

// 由各功能軌道實作的路由：此處只驗證「未登入一律 401」，不對登入後的行為做假設
const FEATURE_PATHS = [
  ['GET', '/api/overview'],
  ['GET', '/api/feedback'],
  ['GET', '/api/personal'],
  ['GET', '/api/eng/repos'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/changes?since=0'],
  ['GET', '/api/events'],
] as const;

// 核心已實作的 API：登入後應正常掛載並回 200
const CORE_LIST_PATHS = ['/api/users', '/api/projects', '/api/statuses', '/api/tasks', '/api/properties'] as const;

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
  ...FEATURE_PATHS,
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

  it.each(CORE_LIST_PATHS)('登入後 GET %s 已掛載並回 200', async (path) => {
    const api = await loggedIn();
    const res = await api.get(path);
    expect(res.status).toBe(200);
  });

  it('未知 API 回 JSON 404', async () => {
    const api = await loggedIn();
    const res = await api.get('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '找不到 API' } });
  });
});
