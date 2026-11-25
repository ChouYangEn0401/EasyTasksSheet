import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 個人頁「匯報報告」：完成任務 / 待辦 → 選本週 → 預覽 → 取消勾選 → 複製 → 下載 .md；上週無資料 → 空狀態
test.describe.configure({ mode: 'serial' });

const SHOTS =
  'C:\\Users\\629\\AppData\\Local\\Temp\\claude\\e7fe0c0dcc39054e\\13d96097-8b6c-4c25-a5d3-fc64b31cc29f\\scratchpad\\report';
const stamp = Date.now();
const T1 = `報告任務甲-${stamp}`;
const T2 = `報告任務乙-${stamp}`;
const D1 = `報告待辦甲-${stamp}`;
const D2 = `報告待辦乙-${stamp}`;
const json = { 'Content-Type': 'application/json' };
const taskIds: number[] = [];
const todoIds: number[] = [];

async function seed(page: Page) {
  const me = (await (await page.request.get('/api/auth/me')).json()) as { user: { id: number } };
  for (const title of [T1, T2]) {
    const res = await page.request.post('/api/tasks', {
      headers: json,
      data: { title, statusId: 4, assigneeId: me.user.id, estimateHours: 2 },
    });
    expect(res.status()).toBe(201);
    taskIds.push(((await res.json()) as { id: number }).id);
  }
  for (const title of [D1, D2]) {
    const todo = (await (
      await page.request.post('/api/personal', { headers: json, data: { title } })
    ).json()) as {
      id: number;
    };
    todoIds.push(todo.id);
    const res = await page.request.patch(`/api/personal/${todo.id}`, {
      headers: json,
      data: { isDone: true },
    });
    expect(res.ok()).toBe(true);
  }
}

// 清除自己建立的資料：其他 spec（personal.spec）假設成員的自由待辦清單原本是空的
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await loginViaUi(page, E2E_USERS.member, '/me');
    for (const id of todoIds) await page.request.delete(`/api/personal/${id}`);
    for (const id of taskIds) await page.request.delete(`/api/tasks/${id}`);
  } finally {
    await page.close();
  }
});

test('匯報報告：預覽、取消勾選、複製、下載 .md、上週空狀態', async ({ page, context }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/me');
  await seed(page);
  await page.goto('/me');

  await page.getByRole('button', { name: '產生匯報報告' }).click();
  const dialog = page.getByRole('dialog', { name: '匯報報告' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('快速區間')).toHaveValue('week');
  for (const t of [T1, T2, D1, D2]) await expect(dialog.getByText(t, { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('report-summary')).toContainText('完成任務');
  await page.waitForTimeout(400); // 等對話框淡入完成
  await page.screenshot({ path: `${SHOTS}\\preview-${page.viewportSize()?.width ?? 0}.png` });

  // 取消勾選任務乙：彙總與輸出同步更新
  await dialog.getByRole('checkbox', { name: `納入：${T2}` }).uncheck();
  await dialog.getByRole('tab', { name: '可編輯文字' }).click();
  const area = dialog.getByRole('textbox', { name: '可編輯文字' });
  await expect(area).toHaveValue(new RegExp(T1));
  await expect(area).not.toHaveValue(new RegExp(T2));
  await expect(area).toHaveValue(/匯報報告/);
  await dialog.getByRole('tab', { name: '預覽' }).click();

  // 複製（剪貼簿）
  await dialog.getByRole('button', { name: '複製', exact: true }).click();
  await expect(page.getByText('已複製到剪貼簿')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(T1);
  expect(clip).toContain(D1);
  expect(clip).not.toContain(T2);

  // Markdown 格式 + 下載 .md
  await dialog.getByLabel('輸出格式').selectOption('markdown');
  await dialog.getByRole('tab', { name: '可編輯文字' }).click();
  await expect(area).toHaveValue(/^# 匯報報告/);
  await page.waitForTimeout(400); // 等對話框淡入完成
  await page.screenshot({ path: `${SHOTS}\\format-${page.viewportSize()?.width ?? 0}.png` });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下載 .md' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^匯報報告_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/);
  const text = readFileSync((await file.path())!, 'utf-8');
  expect(text).toContain('# 匯報報告');
  expect(text).toContain(T1);
  expect(text).toContain(D2);
  expect(text).not.toContain(T2);

  // CSV 下載：UTF-8 BOM
  const csvDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下載 .csv' }).click();
  const csv = readFileSync((await (await csvDownload).path())!);
  expect(csv.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
  expect(csv.toString('utf-8')).toContain(T1);

  // 上週：沒有紀錄
  await dialog.getByLabel('快速區間').selectOption('lastWeek');
  await dialog.getByRole('tab', { name: '預覽' }).click();
  await expect(dialog.getByText('這段期間沒有紀錄').first()).toBeVisible();
  await page.waitForTimeout(400); // 等對話框淡入完成
  await page.screenshot({ path: `${SHOTS}\\empty-${page.viewportSize()?.width ?? 0}.png` });

  // 選項記憶：重新整理後仍為上週
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole('button', { name: '產生匯報報告' }).click();
  await expect(page.getByRole('dialog', { name: '匯報報告' }).getByLabel('快速區間')).toHaveValue('lastWeek');
  expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
});

test('匯報報告：768px 版面與檢視他人成員', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 768, height: 900 });
  await loginViaUi(page, E2E_USERS.member, '/me');
  await page.getByRole('button', { name: '產生匯報報告' }).click();
  const dialog = page.getByRole('dialog', { name: '匯報報告' });
  await expect(dialog.getByTestId('report-summary')).toBeVisible();
  await expect(dialog.getByText(T1, { exact: true })).toBeVisible();
  await page.waitForTimeout(400); // 等對話框淡入完成
  await page.screenshot({ path: `${SHOTS}\\preview-768.png` });
  await dialog.getByRole('tab', { name: '可編輯文字' }).click();
  await page.waitForTimeout(400); // 等對話框淡入完成
  await page.screenshot({ path: `${SHOTS}\\format-768.png` });
  await page.keyboard.press('Escape');

  // 他人：標題標示成員名稱（唯讀資料）
  const users = (await (await page.request.get('/api/users')).json()) as { id: number; username: string }[];
  const peer = users.find((u) => u.username === E2E_USERS.peer.username)!;
  await page.goto(`/me?user=${peer.id}`);
  await page.getByRole('button', { name: '產生匯報報告' }).click();
  await expect(page.getByRole('dialog', { name: `匯報報告：${E2E_USERS.peer.displayName}` })).toBeVisible();
  await expect(page.getByRole('dialog').getByText(T1, { exact: true })).toHaveCount(0);
});
