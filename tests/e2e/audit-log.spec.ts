import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 稽核紀錄與還原（docs/design/audit-log.md）：成員修改描述 → 管理者在稽核頁看到前後差異並還原；
// 衝突時可「仍要還原（覆蓋）」；成員可在任務詳情看到活動歷史但沒有還原鈕。
// SHOTS_DIR 有設定時另存截圖（1280 / 768）。

const nav = (page: Page) => page.getByRole('navigation', { name: '主要導覽' });
const shots = process.env.SHOTS_DIR;

async function newLoggedIn(browser: Browser, user: (typeof E2E_USERS)[keyof typeof E2E_USERS], next = '/') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUi(page, user, next);
  return { context, page };
}

type Task = { id: number; title: string; description: string };
type Entry = { id: number; summary: string; revertedAt: number | null };

// 本 spec 建立的任務：結束時刪除（core-shell spec 假設任務清單一開始是空的）
const created: { page: Page; id: number }[] = [];

async function createTask(page: Page, title: string, description: string): Promise<Task> {
  const res = await page.request.post('/api/tasks', { data: { title, description } });
  expect(res.status()).toBe(201);
  const task = (await res.json()) as Task;
  created.push({ page, id: task.id });
  return task;
}

async function cleanup() {
  for (const { page, id } of created.splice(0))
    await page.request.delete(`/api/tasks/${id}`).catch(() => undefined);
}

async function auditOf(page: Page, taskId: number): Promise<Entry[]> {
  const res = await page.request.get(`/api/admin/audit?taskId=${taskId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: Entry[] }).items;
}

async function shoot(page: Page, name: string, widths = [1280, 768]) {
  if (!shots) return;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    // 等對話框 / 展開動畫結束
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

test('成員改壞描述 → 管理者在稽核頁看到差異並還原；成員的活動歷史沒有還原鈕', async ({ browser }) => {
  const member = await newLoggedIn(browser, E2E_USERS.member);
  const manager = await newLoggedIn(browser, E2E_USERS.manager);
  try {
    const title = `E2E 稽核 ${Date.now()}`;
    const task = await createTask(member.page, title, '請在週五前完成首頁設計稿');

    // 成員在任務詳情修改描述
    await member.page.goto(`/tasks/list?task=${task.id}`);
    const desc = member.page.getByRole('textbox', { name: '描述' });
    await expect(desc).toHaveValue('請在週五前完成首頁設計稿');
    await desc.fill('改成下週再說');
    await desc.blur();
    await expect(member.page.getByText('已儲存')).toBeVisible();

    // 管理者：導覽有「稽核紀錄」，頁首說明語氣中性
    const page = manager.page;
    await nav(page).getByRole('link', { name: '稽核紀錄' }).click();
    await expect(page).toHaveURL(/\/admin\/audit/);
    await expect(page.getByText('用來回溯與還原，而非評比')).toBeVisible();
    await page.getByRole('textbox', { name: '搜尋摘要或名稱' }).fill(title);
    const updated = (await auditOf(page, task.id)).find((e) => e.summary.includes('描述'))!;
    const row = page.locator(`li[data-entry-id="${updated.id}"]`);
    await expect(row).toContainText(`修改了『${title.slice(0, 39)}`);
    await expect(row).toContainText('一般成員');
    await expect(row).toContainText('可還原');
    await shoot(page, 'audit-list');

    // 展開：修改前 / 修改後（行內差異）
    await row.getByRole('button', { name: /修改了/ }).click();
    const diff = row.locator('.aud-diff');
    await expect(diff.locator('td[data-side="before"]')).toContainText('請在週五前完成首頁設計稿');
    await expect(diff.locator('td[data-side="after"]')).toContainText('改成下週再說');
    await expect(diff.locator('del.aud-del').first()).toBeVisible();
    await expect(diff.locator('ins.aud-ins').first()).toBeVisible();
    await shoot(page, 'audit-diff');

    // 還原
    await row.getByRole('button', { name: '還原', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '還原這次改動？' });
    await expect(dialog).toContainText('以下欄位會改回這次修改之前的內容');
    await expect(dialog.getByRole('button', { name: '還原', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '還原', exact: true }).click();
    await expect(page.getByText(/^已還原：/)).toBeVisible();
    await expect(row).toContainText('已還原');
    await expect(row).toContainText('由 管理者');
    const after = (await (await member.page.request.get(`/api/tasks/${task.id}`)).json()) as Task;
    expect(after.description).toBe('請在週五前完成首頁設計稿');

    // 成員：任務詳情的活動歷史可見（含還原紀錄），但沒有還原鈕；也看不到稽核頁入口
    await member.page.goto(`/tasks/list?task=${task.id}`);
    await expect(member.page.getByRole('textbox', { name: '描述' })).toHaveValue('請在週五前完成首頁設計稿');
    await member.page.getByRole('button', { name: '活動歷史' }).click();
    const history = member.page.getByRole('list', { name: '活動歷史' });
    await expect(history).toContainText('還原：修改了');
    await expect(history).toContainText(`建立任務『${title.slice(0, 39)}`);
    await expect(history.getByRole('button', { name: '還原', exact: true })).toHaveCount(0);
    await history.getByRole('button', { name: '查看差異' }).first().click();
    await expect(history).toContainText('修改前');
    if (shots) {
      for (const width of [1280, 768]) {
        await member.page.setViewportSize({ width, height: 900 });
        await member.page.mouse.move(0, 0);
        await history.scrollIntoViewIfNeeded();
        await member.page.screenshot({ path: `${shots}/task-history-${width}.png` });
      }
    }
    await expect(nav(member.page).getByRole('link', { name: '稽核紀錄' })).toHaveCount(0);
  } finally {
    await cleanup();
    await member.context.close();
    await manager.context.close();
  }
});

test('連續修改兩次後還原第一次：提示衝突並可仍要還原（覆蓋）', async ({ browser }) => {
  const manager = await newLoggedIn(browser, E2E_USERS.manager);
  try {
    const page = manager.page;
    const title = `E2E 衝突 ${Date.now()}`;
    const task = await createTask(page, title, '第一版');
    for (const description of ['第二版', '第三版']) {
      const res = await page.request.patch(`/api/tasks/${task.id}`, { data: { description } });
      expect(res.status()).toBe(200);
    }
    const updates = (await auditOf(page, task.id)).filter((e) => e.summary.includes('描述'));
    const first = updates[updates.length - 1]!; // 由新到舊，最後一筆是第一次修改

    await page.goto(`/admin/audit?taskId=${task.id}`);
    const row = page.locator(`li[data-entry-id="${first.id}"]`);
    await row.getByRole('button', { name: '還原', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '還原這次改動？' });
    await expect(dialog).toContainText('在此之後又被修改過');
    await expect(dialog).toContainText('現在是「第三版」');
    await shoot(page, 'audit-conflict');
    await dialog.getByRole('button', { name: '仍要還原（覆蓋）' }).click();
    await expect(page.getByText(/^已還原：/)).toBeVisible();
    const after = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as Task;
    expect(after.description).toBe('第一版');
    // 同一筆不可再還原
    expect((await page.request.post(`/api/admin/audit/${first.id}/revert`, { data: {} })).status()).toBe(409);
  } finally {
    await cleanup();
    await manager.context.close();
  }
});

test('權限不足：成員看不到稽核紀錄入口，直接進入顯示沒有權限', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  await expect(nav(page).getByRole('link', { name: '總覽' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: '稽核紀錄' })).toHaveCount(0);
  await page.goto('/admin/audit');
  await expect(page.getByText('沒有權限')).toBeVisible();
  expect((await page.request.get('/api/admin/audit')).status()).toBe(403);
});
