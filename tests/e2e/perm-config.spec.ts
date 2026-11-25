import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 權限設定（docs/design/permissions-config.md）：root 調整成員權限 → 在線成員不需重新整理即更新（SSE）。
// 結束時一律還原為預設，避免影響其他 spec。

const nav = (page: Page) => page.getByRole('navigation', { name: '主要導覽' });

async function newLoggedIn(browser: Browser, user: (typeof E2E_USERS)[keyof typeof E2E_USERS], next = '/') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUi(page, user, next);
  return { context, page };
}

async function resetDefaults(page: Page) {
  const res = await page.request.post('/api/admin/permissions/reset', { data: {} });
  expect(res.status()).toBe(200);
}

test('root 調整成員權限，在線成員即時看到 / 失去入口；受保護項目不可勾', async ({ browser }) => {
  const root = await newLoggedIn(browser, E2E_USERS.admin);
  const member = await newLoggedIn(browser, E2E_USERS.member);
  try {
    await resetDefaults(root.page);
    const page = root.page;
    await nav(page).getByRole('link', { name: '權限設定' }).click();
    await expect(page).toHaveURL(/\/admin\/permissions/);
    await expect(page.getByText('權限設定即時生效；超級管理員永遠擁有全部權限。')).toBeVisible();

    // 超級管理員欄固定勾選且停用；受保護項目鎖定
    await expect(page.getByLabel('超級管理員：管理狀態（固定擁有）')).toBeChecked();
    await expect(page.getByLabel('超級管理員：管理狀態（固定擁有）')).toBeDisabled();
    for (const label of ['成員：完整備份下載', '管理者：權限設定', '管理者：指派超級管理員']) {
      await expect(page.getByLabel(label)).toBeDisabled();
      await expect(page.getByLabel(label)).not.toBeChecked();
    }
    await expect(page.locator('tr[data-capability="data.backup_db"] .prm-lock')).toBeVisible();

    // 成員原本看不到資料管理
    await expect(nav(member.page).getByRole('link', { name: '總覽' })).toBeVisible();
    await expect(nav(member.page).getByRole('link', { name: '資料管理' })).toHaveCount(0);

    // 授予成員「管理狀態」與「JSON 匯出」
    await page.getByLabel('成員：管理狀態').check();
    await page.getByLabel('成員：JSON 匯出').check();
    const bar = page.getByRole('region', { name: '未儲存的權限變更' });
    await expect(bar).toContainText('2 項未儲存變更');
    await expect(bar).toContainText('成員：＋管理狀態、＋JSON 匯出');
    if (process.env.SHOTS_DIR) {
      const intro = page.getByText('權限設定即時生效；超級管理員永遠擁有全部權限。');
      for (const width of [1280, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await page.mouse.move(0, 0);
        await intro.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.SHOTS_DIR}/perm-top-${width}.png` });
        await page.getByLabel('成員：JSON 匯出').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.SHOTS_DIR}/perm-${width}.png` });
      }
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    // 還原未儲存 → 列消失；再勾一次後儲存
    await bar.getByRole('button', { name: '還原未儲存' }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByLabel('成員：管理狀態')).not.toBeChecked();
    await page.getByLabel('成員：管理狀態').check();
    await page.getByLabel('成員：JSON 匯出').check();
    await bar.getByRole('button', { name: '儲存', exact: true }).click();
    await expect(page.getByText('已儲存權限設定')).toBeVisible();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('tr[data-capability="statuses.manage"]')).toContainText('已自訂');

    // 成員：不需重新整理即出現入口，capabilities 含 statuses.manage
    await expect(nav(member.page).getByRole('link', { name: '資料管理' })).toBeVisible({ timeout: 10_000 });
    const me = await (await member.page.request.get('/api/auth/me')).json();
    expect(me.capabilities).toContain('statuses.manage');
    expect(
      (await member.page.request.post('/api/statuses', { data: { name: 'E2E 權限狀態' } })).status(),
    ).toBe(201);

    // 撤回 → 入口消失
    await page.getByLabel('成員：管理狀態').uncheck();
    await page.getByLabel('成員：JSON 匯出').uncheck();
    await page
      .getByRole('region', { name: '未儲存的權限變更' })
      .getByRole('button', { name: '儲存', exact: true })
      .click();
    await expect(nav(member.page).getByRole('link', { name: '資料管理' })).toHaveCount(0, {
      timeout: 10_000,
    });

    // 還原為預設（需確認）
    await page.getByLabel('成員：JSON 匯出').check();
    await page
      .getByRole('region', { name: '未儲存的權限變更' })
      .getByRole('button', { name: '儲存', exact: true })
      .click();
    await expect(nav(member.page).getByRole('link', { name: '資料管理' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '還原為預設' }).click();
    const dialog = page.getByRole('alertdialog', { name: '還原為預設權限？' });
    await dialog.getByRole('button', { name: '還原' }).click();
    await expect(page.getByText('已還原為預設權限')).toBeVisible();
    await expect(page.getByRole('button', { name: '還原為預設' })).toBeDisabled();
    await expect(nav(member.page).getByRole('link', { name: '資料管理' })).toHaveCount(0, {
      timeout: 10_000,
    });

    // 後端同樣拒絕授予受保護權限
    const res = await page.request.put('/api/admin/permissions', {
      data: { changes: [{ role: 'manager', capability: 'data.backup_db', allowed: true }] },
    });
    expect(res.status()).toBe(400);

    // 成員看不到權限設定入口、API 403
    await expect(nav(member.page).getByRole('link', { name: '權限設定' })).toHaveCount(0);
    expect((await member.page.request.get('/api/admin/permissions')).status()).toBe(403);
  } finally {
    await resetDefaults(root.page);
    // 刪除測試建立的狀態（若有）
    const statuses = (await (await root.page.request.get('/api/statuses')).json()) as {
      id: number;
      name: string;
    }[];
    for (const s of statuses.filter((x) => x.name === 'E2E 權限狀態'))
      await root.page.request.delete(`/api/statuses/${s.id}`);
    await root.context.close();
    await member.context.close();
  }
});

test('manager 看不到權限設定', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.manager);
  await expect(nav(page).getByRole('link', { name: '成員管理' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '權限設定' })).toHaveCount(0);
  await page.goto('/admin/permissions');
  await expect(page.getByText('沒有權限')).toBeVisible();
});
