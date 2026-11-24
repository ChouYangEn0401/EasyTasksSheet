import { expect, test } from '@playwright/test';

// 冒煙：正式模式單一行程同時提供 API 與前端
test('health 與首頁', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);

  const stub = await request.get('/api/overview');
  expect(stub.status()).toBe(501);

  const page = await request.get('/some/spa/route');
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
});
