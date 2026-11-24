import { expect, test } from '@playwright/test';
import { E2E_USERS } from '../helpers/e2e.ts';

// 冒煙：正式模式單一行程同時提供 API 與前端
test('health 與首頁', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);

  // 未登入存取 API 回 401；登入後未實作的 stub 回 501
  expect((await request.get('/api/overview')).status()).toBe(401);
  const login = await request.post('/api/auth/login', {
    data: { username: E2E_USERS.admin.username, password: E2E_USERS.admin.password },
  });
  expect(login.status()).toBe(200);
  const stub = await request.get('/api/eng/repos');
  expect(stub.status()).toBe(501);

  const page = await request.get('/some/spa/route');
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
});
