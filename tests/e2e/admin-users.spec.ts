import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// T7 成員管理：權限、列出 / 搜尋、新增（臨時密碼 → 強制改密碼）、停用使 session 失效、啟用、
// 重設密碼、編輯、解除登入鎖定、最後一位管理員保護。只操作本 spec 自建的帳號，不影響其他 spec。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const USERNAME = `e2e-${stamp}`;
const NAME = `E2E 新成員 ${stamp}`;
const RENAMED = `E2E 改名 ${stamp}`;

const row = (page: Page, username: string) => page.locator(`tbody tr[data-username="${username}"]`);

async function openMenu(page: Page, name: string) {
  await page.getByRole('button', { name: `${name} 的操作` }).click();
  return page.getByRole('menu', { name: `${name} 的操作` });
}

test('一般成員：側邊導覽無入口、頁面顯示沒有權限、API 回 403', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  await expect(page.getByRole('navigation', { name: '主要導覽' }).getByText('成員管理')).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByText('沒有權限')).toBeVisible();
  await expect(page.getByText('此頁面僅限管理員使用')).toBeVisible();
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  await page.getByRole('button', { name: '回到總覽' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('管理員：新增 → 首次登入改密碼 → 停用即登出 → 啟用 → 重設密碼 → 編輯 → 解鎖 → 最後管理員保護', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin, '/admin/users');

  // 列表：自己那列有「你」，每列都有更新時間
  const me = row(page, E2E_USERS.admin.username);
  await expect(me).toBeVisible();
  await expect(me.getByText('你', { exact: true })).toBeVisible();
  await expect(me.locator('td').nth(1)).toHaveText('管理員');
  const rowCount = await page.locator('tbody tr').count();
  await expect(page.locator('tbody tr td.adm-col-updated time')).toHaveCount(rowCount);

  // 搜尋（/ 聚焦）與無結果 → 清除篩選
  await page.locator('body').click();
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: '搜尋姓名或帳號' });
  await expect(search).toBeFocused();
  await search.fill('zzz-no-such-user');
  await expect(page).toHaveURL(/q=zzz-no-such-user/);
  await expect(page.getByText('沒有符合條件的成員')).toBeVisible();
  await page.getByRole('button', { name: '清除篩選' }).click();
  await expect(me).toBeVisible();
  await expect(page).not.toHaveURL(/q=/);

  // 新增成員：Enter 送出 → 結果面板顯示一次臨時密碼；Esc 不關閉
  await page.getByRole('button', { name: '新增成員' }).click();
  const create = page.getByRole('dialog', { name: '新增成員' });
  await expect(create.getByLabel('帳號')).toBeFocused();
  await create.getByLabel('帳號').fill('x');
  await create.getByLabel('顯示名稱').fill(NAME);
  await create.getByLabel('顯示名稱').press('Enter');
  await expect(create.getByText('帳號須為 3–32 個英文字母')).toBeVisible();
  await create.getByLabel('帳號').fill(E2E_USERS.member.username);
  await create.getByRole('button', { name: '建立' }).click();
  await expect(create.getByText('此帳號已被使用')).toBeVisible();
  await create.getByLabel('帳號').fill(USERNAME);
  await create.getByLabel('顯示名稱').press('Enter');

  const created = page.getByRole('dialog', { name: `已建立成員「${NAME}」` });
  await expect(created).toBeVisible();
  await expect(created.getByRole('button', { name: '複製' })).toBeFocused();
  const tempPassword = (await created.getByLabel('臨時密碼').textContent())!.trim();
  expect(tempPassword).toMatch(/^\S{4}-\S{4}-\S{4}$/);
  await page.keyboard.press('Escape');
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: '完成' }).click();
  await expect(created).toBeHidden();
  expect(page.url()).not.toContain(tempPassword);

  const newRow = row(page, USERNAME);
  await expect(newRow.getByText('待改密碼')).toBeVisible();
  await expect(newRow.getByText('啟用', { exact: true })).toBeVisible();

  // 新成員以臨時密碼登入 → 強制改密碼
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.goto('/login');
  await other.getByLabel('帳號').fill(USERNAME);
  await other.getByLabel('密碼', { exact: true }).fill(tempPassword);
  await other.getByRole('button', { name: '登入' }).click();
  await expect(other.getByText('請先設定新密碼')).toBeVisible();
  const newPassword = `e2e-new-pass-${stamp}`;
  await other.getByLabel('目前密碼', { exact: true }).fill(tempPassword);
  await other.getByLabel('新密碼', { exact: true }).fill(newPassword);
  await other.getByLabel('確認新密碼', { exact: true }).fill(newPassword);
  await other.getByRole('button', { name: '更新密碼' }).click();
  await expect(other.getByRole('navigation', { name: '主要導覽' })).toBeVisible();

  // 停用 → 該成員的 session 立即失效
  await page.reload();
  await expect(newRow.getByText('待改密碼')).toHaveCount(0);
  await (await openMenu(page, NAME)).getByRole('menuitem', { name: '停用' }).click();
  const disable = page.getByRole('alertdialog', { name: `停用「${NAME}」？` });
  await expect(disable.getByText('目前的登入狀態會立即失效')).toBeVisible();
  await disable.getByRole('button', { name: '停用' }).click();
  await expect(page.getByRole('status').filter({ hasText: `已停用「${NAME}」` })).toBeVisible();
  await expect(newRow.getByText('已停用')).toBeVisible();
  expect((await other.request.get('/api/auth/me')).status()).toBe(401);
  await other.reload();
  await expect(other).toHaveURL(/\/login/);
  await ctx.close();

  // 狀態篩選：已停用
  await page.getByRole('button', { name: '狀態篩選' }).click();
  await page.getByRole('option', { name: '已停用' }).click();
  await expect(page).toHaveURL(/state=disabled/);
  await expect(newRow).toBeVisible();
  await expect(me).toHaveCount(0);
  await page.getByRole('button', { name: '狀態篩選' }).click();
  await page.getByRole('option', { name: '全部' }).click();

  // 啟用（立即執行）
  await (await openMenu(page, NAME)).getByRole('menuitem', { name: '啟用' }).click();
  await expect(page.getByRole('status').filter({ hasText: `已啟用「${NAME}」` })).toBeVisible();
  await expect(newRow.getByText('啟用', { exact: true })).toBeVisible();

  // 重設密碼：確認 → 結果面板（複製 → 已複製）
  await (await openMenu(page, NAME)).getByRole('menuitem', { name: '重設密碼' }).click();
  const confirmReset = page.getByRole('dialog', { name: `重設「${NAME}」的密碼？` });
  await confirmReset.getByRole('button', { name: '重設密碼' }).click();
  const resetDone = page.getByRole('dialog', { name: `已重設「${NAME}」的密碼` });
  await expect(resetDone.getByText('該成員下次登入時須設定新密碼。')).toBeVisible();
  const resetPassword = (await resetDone.getByLabel('臨時密碼').textContent())!.trim();
  expect(resetPassword).not.toBe(tempPassword);
  await resetDone.getByRole('button', { name: '複製' }).click();
  await expect(resetDone.getByRole('button', { name: '已複製' })).toBeVisible();
  await resetDone.getByRole('button', { name: '關閉' }).click();
  await expect(resetDone).toBeHidden();
  await expect(newRow.getByText('待改密碼')).toBeVisible();

  // 編輯顯示名稱與角色
  await (await openMenu(page, NAME)).getByRole('menuitem', { name: '編輯' }).click();
  const edit = page.getByRole('dialog', { name: '編輯成員' });
  const save = edit.getByRole('button', { name: '儲存' });
  await expect(save).toBeDisabled();
  await edit.getByLabel('顯示名稱').fill(RENAMED);
  await edit.getByLabel('顯示名稱').press('Enter');
  await expect(page.getByRole('status').filter({ hasText: `已更新「${RENAMED}」` })).toBeVisible();
  await expect(newRow.getByText(RENAMED)).toBeVisible();

  // 連續登入失敗 → 已鎖定 → 解除鎖定
  for (let i = 0; i < 5; i++) {
    const res = await request.post('/api/auth/login', {
      data: { username: USERNAME, password: 'wrong-password' },
    });
    expect(res.status()).toBe(401);
  }
  await page.reload();
  await expect(newRow.getByText('已鎖定')).toBeVisible();
  await (await openMenu(page, RENAMED)).getByRole('menuitem', { name: '解除鎖定' }).click();
  await expect(page.getByRole('status').filter({ hasText: `已解除「${RENAMED}」的登入鎖定` })).toBeVisible();
  await expect(newRow.getByText('已鎖定')).toHaveCount(0);
  const relogin = await request.post('/api/auth/login', {
    data: { username: USERNAME, password: resetPassword },
  });
  expect(relogin.status()).toBe(200);

  // 最後一位管理員：停用選項停用並說明原因；編輯時「成員」選項停用
  const menu = await openMenu(page, E2E_USERS.admin.displayName);
  await expect(menu.getByRole('menuitem', { name: '停用' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByText('至少需保留一位管理員')).toBeVisible();
  await menu.getByRole('menuitem', { name: '編輯' }).click();
  const editMe = page.getByRole('dialog', { name: '編輯成員' });
  await expect(editMe.getByText('至少需保留一位管理員')).toBeVisible();
  await editMe.getByRole('button', { name: '角色' }).click();
  await expect(page.getByRole('option', { name: '成員' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await editMe.getByRole('button', { name: '取消' }).click();
  // 後端同樣拒絕
  const meId = (await (await page.request.get('/api/auth/me')).json()).user.id as number;
  const denied = await page.request.patch(`/api/admin/users/${meId}`, { data: { isActive: false } });
  expect(denied.status()).toBe(409);

  expect(errors.filter((e) => !/401|409|Failed to load resource/.test(e))).toEqual([]);
});
