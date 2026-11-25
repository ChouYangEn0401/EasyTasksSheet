import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 三層角色（docs/permissions.md）：user 看不到管理入口；manager 可管理成員與資料但不能設 root、
// 看不到完整備份與取代全部；root 皆可。只讀取畫面與 API，不改動任何共用帳號的角色。

const nav = (page: Page) => page.getByRole('navigation', { name: '主要導覽' });

async function openCreateRoleOptions(page: Page) {
  await page.getByRole('button', { name: '新增成員' }).click();
  const dialog = page.getByRole('dialog', { name: '新增成員' });
  await dialog.getByRole('button', { name: '角色' }).click();
  return dialog;
}

test('user：看不到成員管理與資料管理', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  await expect(nav(page).getByRole('link', { name: '總覽' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '成員管理' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: '資料管理' })).toHaveCount(0);
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.user.role).toBe('user');
  expect(me.capabilities).not.toContain('members.manage');
});

test('manager：可進成員管理但不能設 root、不能動 root 帳號；資料管理無完整備份與取代', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.manager);
  await nav(page).getByRole('link', { name: '成員管理' }).click();
  await expect(page).toHaveURL(/\/admin\/users/);

  // root 帳號：看得到，但操作停用並說明
  const rootRow = page.locator(`tbody tr[data-username="${E2E_USERS.admin.username}"]`);
  await expect(rootRow.locator('td').nth(1)).toHaveText('超級管理員');
  await page.getByRole('button', { name: `${E2E_USERS.admin.displayName} 的操作` }).click();
  const menu = page.getByRole('menu', { name: `${E2E_USERS.admin.displayName} 的操作` });
  await expect(menu.getByRole('menuitem', { name: '編輯' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByText('只有超級管理員可以管理此帳號')).toBeVisible();
  await page.keyboard.press('Escape');

  // 新增成員：角色三層，超級管理員不可選
  const dialog = await openCreateRoleOptions(page);
  await expect(page.getByRole('option', { name: '超級管理員' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('option', { name: '管理者', exact: true })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('只有超級管理員可以指派超級管理員')).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();

  // 後端同樣拒絕：設 root、操作 root 帳號
  const users = (await (await page.request.get('/api/admin/users')).json()) as {
    id: number;
    username: string;
  }[];
  const id = (name: string) => users.find((u) => u.username === name)!.id;
  const toRoot = await page.request.patch(`/api/admin/users/${id(E2E_USERS.member.username)}`, {
    data: { role: 'root' },
  });
  expect(toRoot.status()).toBe(403);
  const touchRoot = await page.request.post(`/api/admin/users/${id(E2E_USERS.admin.username)}/unlock`);
  expect(touchRoot.status()).toBe(403);

  // 資料管理：JSON 匯出與匯入可用；完整備份與取代全部不顯示、API 403
  await nav(page).getByRole('link', { name: '資料管理' }).click();
  await expect(page.getByRole('button', { name: '下載 JSON 匯出檔' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '匯入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下載完整備份' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '取代全部資料' })).toHaveCount(0);
  expect((await page.request.get('/api/admin/data/backup')).status()).toBe(403);
});

test('root：成員管理可選超級管理員；資料管理有完整備份與取代全部', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.admin, '/admin/users');
  await openCreateRoleOptions(page);
  await expect(page.getByRole('option', { name: '超級管理員' })).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '新增成員' }).getByRole('button', { name: '取消' }).click();

  await nav(page).getByRole('link', { name: '資料管理' }).click();
  await expect(page.getByRole('button', { name: '下載 JSON 匯出檔' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下載完整備份' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '取代全部資料' })).toBeVisible();
});
