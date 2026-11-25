import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// feat/status-project：statuses.manage 者可在清單 / 看板管理狀態；projects.create 者可在 FilterBar 直接新增專案。
// 截圖：設 E2E_SHOTS=<目錄> 時輸出（驗收用）。
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.E2E_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // 等對話框淡入
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

type Status = { id: number; name: string };

test('manager：新增狀態出現在清單 / 看板 / 篩選；刪除使用中的狀態走改移流程', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const name = `驗收${Date.now() % 100000}`;
  await loginViaUi(page, E2E_USERS.manager);
  // 清單要有任務才會出現群組標頭列
  const seed = await (await page.request.post('/api/tasks', { data: { title: `E2E-seed-${name}` } })).json();
  await page.goto('/tasks/list');
  await expect(page.locator('.tl-row--group').first()).toBeVisible();

  // 群組標頭列末端的「＋ 新增狀態」
  await page.getByRole('button', { name: '新增狀態' }).first().click();
  const add = page.getByRole('dialog', { name: '新增狀態' });
  await add.getByLabel('狀態名稱').fill(name);
  await shot(page, '01-add-status-dialog');
  await page.keyboard.press('Enter');
  await expect(add).toBeHidden();
  await expect(page.getByText(`已新增狀態「${name}」`)).toBeVisible();

  const statuses = (await (await page.request.get('/api/statuses')).json()) as Status[];
  const created = statuses.find((s) => s.name === name)!;
  expect(created).toBeTruthy();

  // 篩選的狀態選項、看板欄位立即出現
  await page.getByRole('button', { name: '狀態', exact: true }).click();
  await expect(page.getByRole('option', { name })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/tasks/kanban');
  await expect(page.getByRole('button', { name: '新增欄位' })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.getByRole('button', { name: '新增欄位' }).scrollIntoViewIfNeeded();
  await shot(page, '02-kanban-add-column');

  // 建一筆任務放在新狀態，再由清單的狀態下拉「管理狀態…」開對話框
  const title = `E2E-${name}`;
  const t = await (await page.request.post('/api/tasks', { data: { title, statusId: created.id } })).json();
  await page.goto(`/tasks/list?q=${encodeURIComponent(title)}`);
  await page.getByRole('button', { name: `狀態：${name}` }).click();
  await page.getByRole('button', { name: '管理狀態…' }).click();
  const manage = page.getByRole('dialog', { name: '管理狀態' });
  await expect(manage.getByText('類別決定統計與看板歸類')).toBeVisible();
  const row = manage.getByTestId('status-row').filter({ has: page.getByLabel(`狀態名稱：${name}`) });
  await expect(row.getByText('1 筆任務')).toBeVisible();

  // 改名、改色
  await row.getByLabel(`狀態名稱：${name}`).fill(`${name}改`);
  await row.getByLabel(`狀態名稱：${name}`).press('Enter');
  await expect(manage.getByLabel(`狀態名稱：${name}改`)).toBeVisible();
  await manage.getByLabel(`顏色：${name}改`).getByRole('radio', { name: 'orange' }).click();
  await shot(page, '03-manage-statuses');

  // 刪除使用中的狀態：改移到「待辦」
  await manage.getByRole('button', { name: `刪除狀態：${name}改` }).click();
  const panel = manage.getByTestId('delete-status-panel');
  await expect(panel).toContainText('有 1 筆任務');
  await shot(page, '04-migrate-and-delete');
  await panel.getByRole('button', { name: '改移任務並刪除' }).click();
  await expect(manage.getByLabel(`狀態名稱：${name}改`)).toHaveCount(0);

  const after = (await (await page.request.get('/api/statuses')).json()) as Status[];
  expect(after.some((s) => s.id === created.id)).toBe(false);
  const moved = await (await page.request.get(`/api/tasks/${t.id}`)).json();
  expect(moved.statusId).not.toBe(created.id);
  await manage.getByRole('button', { name: '完成', exact: true }).click();
  await page.request.delete(`/api/tasks/${t.id}`);
  await page.request.delete(`/api/tasks/${seed.id}`);
});

test('user：看不到狀態管理入口，但能新增專案並自動套用篩選', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.member);
  const seed = await (
    await page.request.post('/api/tasks', { data: { title: `E2E-seed-${Date.now()}` } })
  ).json();
  await page.goto('/tasks/list');
  await expect(page.locator('.tl-row--group').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '新增狀態' })).toHaveCount(0);
  await page.goto('/tasks/kanban');
  await expect(page.getByRole('button', { name: '新增欄位' })).toHaveCount(0);

  // 狀態欄位下拉沒有「管理狀態…」
  const title = `E2E-user-${Date.now() % 100000}`;
  const t = await (await page.request.post('/api/tasks', { data: { title } })).json();
  await page.goto(`/tasks/list?q=${encodeURIComponent(title)}`);
  await page
    .getByRole('button', { name: /^狀態：/ })
    .first()
    .click();
  await expect(page.getByRole('option').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '管理狀態…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.request.delete(`/api/tasks/${t.id}`);
  await page.request.delete(`/api/tasks/${seed.id}`);

  // FilterBar 專案下拉底部「新增專案」；無 projects.manage 看不到「管理專案…」
  await page.goto('/tasks/list');
  const pname = `專案${Date.now() % 100000}`;
  await page.getByRole('button', { name: '專案', exact: true }).click();
  await expect(page.getByRole('button', { name: '管理專案…' })).toHaveCount(0);
  await shot(page, '05-project-dropdown');
  await page.getByRole('button', { name: '新增專案' }).click();
  const dlg = page.getByRole('dialog', { name: '新增專案' });
  await dlg.getByLabel('專案顏色').getByRole('radio', { name: 'teal' }).click();
  await dlg.getByLabel('專案名稱').fill(pname);
  await shot(page, '06-add-project-dialog');
  await page.keyboard.press('Enter');
  await expect(dlg).toBeHidden();
  await expect(page.getByText(`已新增專案「${pname}」`)).toBeVisible();
  // 建立後自動成為目前的專案篩選
  await expect(page).toHaveURL(/project=\d+/);
  await expect(page.getByRole('button', { name: `專案：${pname}` })).toBeVisible();

  // 收尾：由 manager 封存測試專案（預設專案不可刪除，其他專案也只封存）
  const projects = (await (await page.request.get('/api/projects')).json()) as { id: number; name: string }[];
  const mine = projects.find((p) => p.name === pname)!;
  const ctx = await browser.newContext();
  const mgr = await ctx.newPage();
  await loginViaUi(mgr, E2E_USERS.manager);
  // manager 在管理專案對話框中封存
  await mgr.goto('/tasks/list');
  await mgr.getByRole('button', { name: '專案', exact: true }).click();
  await mgr.getByRole('button', { name: '管理專案…' }).click();
  const pm = mgr.getByRole('dialog', { name: '管理專案' });
  await shot(mgr, '07-manage-projects');
  await pm.getByRole('button', { name: `封存：${pname}` }).click();
  await expect(pm.getByTestId('project-row').filter({ hasText: pname })).toHaveCount(0);
  const check = (await (await mgr.request.get('/api/projects')).json()) as {
    id: number;
    isArchived: boolean;
  }[];
  expect(check.find((p) => p.id === mine.id)!.isArchived).toBe(true);
  await ctx.close();
});

test('後端 403：沒有權限的人呼叫管理 API 顯示中文錯誤', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  const res = await page.request.post('/api/statuses', { data: { name: 'x' } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.message).toBe('沒有權限執行此操作');
});
