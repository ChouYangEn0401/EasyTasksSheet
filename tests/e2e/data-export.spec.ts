import { expect, test, type APIRequestContext } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 資料管理：權限、完整備份下載（含敏感確認）、JSON 匯出 → 改動資料 → 匯入預覽出現衝突 →
// 全域 keep_local + 逐筆 use_import → 結果正確。只改動本 spec 自建的任務。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const TITLE_A = `E2E 匯入 A ${stamp}`;
const TITLE_B = `E2E 匯入 B ${stamp}`;

type Task = { id: number; title: string };

async function createTask(request: APIRequestContext, title: string): Promise<Task> {
  const res = await request.post('/api/tasks', { data: { title } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Task;
}

async function getTask(request: APIRequestContext, id: number): Promise<Task> {
  return (await (await request.get(`/api/tasks/${id}`)).json()) as Task;
}

test('一般成員：導覽無入口、頁面沒有權限、API 403', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  await expect(page.getByRole('navigation', { name: '主要導覽' }).getByText('資料管理')).toHaveCount(0);
  await page.goto('/admin/data');
  await expect(page.getByText('沒有權限')).toBeVisible();
  expect((await page.request.get('/api/admin/data/export')).status()).toBe(403);
  expect((await page.request.get('/api/admin/data/backup')).status()).toBe(403);
});

test('管理員：備份下載、匯出 → 改動 → 匯入衝突 → keep_local + 逐筆 use_import', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin);
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '資料管理' }).click();
  await expect(page).toHaveURL(/\/admin\/data$/);

  const a = await createTask(page.request, TITLE_A);
  const b = await createTask(page.request, TITLE_B);

  // 完整備份：先經過敏感性確認
  await page.getByRole('button', { name: '下載完整備份' }).click();
  const dialog = page.getByRole('alertdialog', { name: '下載完整備份？' });
  await expect(dialog.getByText('密碼雜湊')).toBeVisible();
  const backupDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '我了解，下載' }).click();
  expect((await backupDownload).suggestedFilename()).toMatch(/^tasks-sheets-backup-\d{8}-\d{6}\.db$/);

  // 匯出 JSON
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載 JSON 匯出檔' }).click();
  const download = await exportDownload;
  expect(download.suggestedFilename()).toMatch(/^tasks-sheets-export-\d{8}-\d{6}\.json$/);
  const file = await download.path();

  // 匯出後在本機改動兩筆（本機較新）
  for (const [t, title] of [
    [a, `${TITLE_A} 本機改`],
    [b, `${TITLE_B} 本機改`],
  ] as const) {
    const res = await page.request.patch(`/api/tasks/${t.id}`, { data: { title } });
    expect(res.status()).toBe(200);
  }

  // 匯入預覽：兩筆衝突
  await page.getByLabel('選擇匯出檔').setInputFiles(file);
  const preview = page.getByLabel('匯入預覽');
  await expect(preview).toBeVisible();
  await expect(preview.locator('tr[data-category="tasks"] td').nth(4)).toHaveText('2');
  const conflictA = preview.locator('.dat-conflict', { hasText: TITLE_A });
  const conflictB = preview.locator('.dat-conflict', { hasText: TITLE_B });
  await expect(conflictA).toBeVisible();
  await expect(conflictA.getByText('本機較新')).toBeVisible();
  await expect(conflictA.getByRole('cell', { name: `${TITLE_A} 本機改` })).toBeVisible();

  // 全域 keep_local，A 逐筆改為 use_import
  await preview.getByRole('button', { name: '全域策略' }).click();
  await page.getByRole('option', { name: '保留本機' }).click();
  await conflictA.getByRole('button', { name: `「${TITLE_A}」的處理方式` }).click();
  await page.getByRole('option', { name: '使用匯入檔' }).click();
  await expect(conflictB.getByRole('button', { name: `「${TITLE_B}」的處理方式` })).toContainText(
    '依全域策略（保留本機）',
  );

  await preview.getByRole('button', { name: '套用匯入' }).click();
  const confirm = page.getByRole('alertdialog', { name: '確定套用匯入？' });
  await expect(confirm).toContainText('有 1 筆採用匯入檔');
  await confirm.getByRole('button', { name: '套用' }).click();

  const result = page.getByLabel('匯入結果');
  await expect(result.getByText(/匯入完成：新增 0、更新 1/)).toBeVisible();
  await expect(result.getByText(/pre-import-\d{8}-\d{6}\.db/)).toBeVisible();
  await expect(result.locator('tr[data-category="tasks"] td').nth(2)).toHaveText('1');

  expect((await getTask(page.request, a.id)).title).toBe(TITLE_A);
  expect((await getTask(page.request, b.id)).title).toBe(`${TITLE_B} 本機改`);

  await result.getByRole('button', { name: '完成' }).click();
  await expect(page.getByText('尚未選擇檔案')).toBeVisible();

  // 清理本 spec 的任務
  await page.request.delete(`/api/tasks/${a.id}`);
  await page.request.delete(`/api/tasks/${b.id}`);
  // 登入前的 /api/auth/me 401 屬正常
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});
