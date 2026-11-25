import { expect, test, type Browser, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 個人設定：自建專用成員（由 admin 建立 → 首次登入改密碼），不動 admin / member / newbie 的狀態；
// 測完以 admin 停用該測試帳號。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const USERNAME = `set-${stamp}`;
const RENAMED = `set2-${stamp}`;
const NAME = `設定測試 ${stamp}`;
const NEW_NAME = `改名後 ${stamp}`;
const PW1 = 'settings-pass-1';
const PW2 = 'settings-pass-2';

async function createUser(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginViaUi(page, E2E_USERS.admin, '/admin/users');
  const res = await page.request.post('/api/admin/users', {
    data: { username: USERNAME, displayName: NAME },
  });
  expect(res.status()).toBe(201);
  const temp = ((await res.json()) as { tempPassword: string }).tempPassword;
  await ctx.close();
  return temp;
}

async function firstLogin(page: Page, temp: string) {
  await page.goto('/login');
  await page.getByLabel('帳號').fill(USERNAME);
  await page.getByLabel('密碼', { exact: true }).fill(temp);
  await page.getByRole('button', { name: '登入' }).click();
  await page.getByLabel('目前密碼').fill(temp);
  await page.getByLabel('新密碼', { exact: true }).fill(PW1);
  await page.getByLabel('確認新密碼').fill(PW1);
  await page.getByRole('button', { name: '更新密碼' }).click();
  await expect(page.getByRole('navigation', { name: '主要導覽' })).toBeVisible();
}

test('個人設定：改顯示名稱、改密碼（其他裝置登出）、改帳號，最後停用測試帳號', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const temp = await createUser(browser);
  await firstLogin(page, temp);

  // 另一個裝置的 session，改密碼後應被登出
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await loginViaUi(other, { username: USERNAME, password: PW1 });

  // 從使用者選單進入
  await page.getByRole('button', { name: /使用者選單/ }).click();
  await page.getByRole('menuitem', { name: '個人設定' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '個人資料' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '帳號資訊' })).toBeVisible();

  // 顯示名稱：未變更不可儲存、空白報錯、儲存成功後頂欄更新
  const profileForm = page.getByRole('form', { name: '個人資料' });
  const save = profileForm.getByRole('button', { name: '儲存變更' });
  await expect(save).toBeDisabled();
  await profileForm.getByLabel('顯示名稱').fill('');
  await expect(profileForm.getByText('請輸入顯示名稱')).toBeVisible();
  await profileForm.getByLabel('顯示名稱').fill(NEW_NAME);
  await save.click();
  await expect(page.getByRole('button', { name: `使用者選單：${NEW_NAME}` })).toBeVisible();
  await expect(page.getByText('個人資料已更新')).toBeVisible();

  // 密碼：規則提示、不一致報錯、目前密碼錯誤、成功
  const pwForm = page.getByRole('form', { name: '變更密碼' });
  const update = pwForm.getByRole('button', { name: '更新密碼' });
  await pwForm.getByLabel('目前密碼').fill(PW1);
  await pwForm.getByLabel('新密碼', { exact: true }).fill('short');
  await expect(pwForm.getByText('至少需要 8 個字元')).toBeVisible();
  await pwForm.getByLabel('新密碼', { exact: true }).fill(PW2);
  await pwForm.getByLabel('確認新密碼').fill('different-pass');
  await expect(pwForm.getByText('兩次輸入的新密碼不一致')).toBeVisible();
  await expect(update).toBeDisabled();
  await pwForm.getByLabel('確認新密碼').fill(PW2);
  await pwForm.getByLabel('目前密碼').fill('wrong-current-pass');
  await update.click();
  await expect(pwForm.getByText('目前密碼不正確')).toBeVisible();
  await pwForm.getByLabel('目前密碼').fill(PW1);
  await update.click();
  await expect(pwForm.getByText('密碼已更新，其他裝置已登出。')).toBeVisible();

  // 其他裝置已登出；新密碼可登入
  expect((await other.request.get('/api/auth/me')).status()).toBe(401);
  await otherCtx.close();
  const fresh = await browser.newContext();
  await loginViaUi(await fresh.newPage(), { username: USERNAME, password: PW2 });
  await fresh.close();

  // 改帳號：需目前密碼；密碼錯、重複、格式錯誤標在欄位
  await page.reload();
  const form = page.getByRole('form', { name: '個人資料' });
  const username = form.getByLabel('帳號', { exact: true });
  await username.fill(RENAMED);
  await expect(form.getByLabel('目前密碼')).toBeVisible();
  await expect(form.getByRole('button', { name: '儲存變更' })).toBeDisabled();
  await form.getByLabel('目前密碼').fill('wrong-current-pass');
  await form.getByRole('button', { name: '儲存變更' }).click();
  await expect(form.getByText('目前密碼不正確')).toBeVisible();
  await username.fill(E2E_USERS.member.username);
  await form.getByLabel('目前密碼').fill(PW2);
  await form.getByRole('button', { name: '儲存變更' }).click();
  await expect(form.getByText('此帳號已被使用')).toBeVisible();
  await username.fill('Bad Name!');
  await expect(form.getByText(/3–32/).last()).toBeVisible();
  await username.fill(RENAMED.toUpperCase());
  await form.getByLabel('目前密碼').fill(PW2);
  await form.getByRole('button', { name: '儲存變更' }).click();
  await expect(username).toHaveValue(RENAMED);
  await expect(form.getByLabel('目前密碼')).toHaveCount(0);

  // 目前 session 仍有效；新帳號可登入
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  const ctx3 = await browser.newContext();
  await loginViaUi(await ctx3.newPage(), { username: RENAMED, password: PW2 });
  await ctx3.close();

  // 還原：admin 停用測試帳號
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await loginViaUi(adminPage, E2E_USERS.admin);
  const list = (await (await adminPage.request.get('/api/admin/users')).json()) as {
    id: number;
    username: string;
  }[];
  const created = list.find((u) => u.username === RENAMED);
  expect(created).toBeTruthy();
  const off = await adminPage.request.patch(`/api/admin/users/${created!.id}`, { data: { isActive: false } });
  expect(off.status()).toBe(200);
  await adminCtx.close();

  expect(errors.filter((e) => !/401|Failed to load resource/.test(e))).toEqual([]);
});

test('一般成員：768 寬度可用，且 role 無法經 API 更動', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await loginViaUi(page, E2E_USERS.member, '/settings');
  await expect(page.getByRole('heading', { name: '個人資料' })).toBeVisible();
  await expect(page.getByRole('form', { name: '個人資料' }).getByLabel('帳號', { exact: true })).toHaveValue(
    E2E_USERS.member.username,
  );
  const before = (await (await page.request.get('/api/profile')).json()) as { role: string };
  const res = await page.request.patch('/api/profile', { data: { role: 'admin' } });
  expect(res.status()).toBe(400);
  const after = (await (await page.request.get('/api/profile')).json()) as { role: string };
  expect(after.role).toBe(before.role);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
