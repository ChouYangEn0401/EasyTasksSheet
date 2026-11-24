import { expect, type Page } from '@playwright/test';

export { E2E_USERS } from './e2eUsers.ts';

export type E2EUser = { username: string; password: string };

/** 以登入頁登入並等待進入 shell（next 為登入後要前往的路徑） */
export async function loginViaUi(page: Page, user: E2EUser, next = '/') {
  await page.goto(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('帳號').fill(user.username);
  await page.getByLabel('密碼', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page.getByRole('navigation', { name: '主要導覽' })).toBeVisible();
}

/** 收集頁面 console error 與未捕捉例外 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
