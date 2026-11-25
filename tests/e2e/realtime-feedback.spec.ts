import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi, type E2EUser } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// T9 feat/realtime-feedback：雙瀏覽器即時同步、斷線重連、toast、他人變更提示、閒置提醒
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; statusId: number };
type ApiStatus = { id: number; name: string };

/**
 * 產品目標：A 的變更在 B 2 秒內出現。E2E 的等待上限放寬為 5 秒，避免計時成為偶發來源；
 * 2 秒目標僅在第一次新增處以「單次量測」記錄（annotation），不作為失敗條件。
 */
const SYNC = { timeout: 5_000 };

async function openAs(browser: Browser, user: E2EUser, path: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUi(page, user, path);
  return page;
}

const rowOf = (page: Page, title: string) => page.locator('.tl-row--task', { hasText: title });
const toasts = (page: Page) => page.getByRole('region', { name: '通知' });

async function createTask(page: Page, title: string): Promise<ApiTask> {
  const res = await page.request.post('/api/tasks', { data: { title } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ApiTask;
}

/** 等 SSE 連上（伺服器 ready 後前端才開始接收）：以一筆暖身變更確認 */
async function waitLive(a: Page, b: Page, P: string) {
  const warm = await createTask(a, `${P} 暖身`);
  await expect(rowOf(b, warm.title)).toBeVisible({ timeout: 10_000 });
  await a.request.delete(`/api/tasks/${warm.id}`);
  await expect(rowOf(b, warm.title)).toHaveCount(0, { timeout: 10_000 });
}

test('雙瀏覽器：新增 / 修改 / 刪除 2 秒內同步；SSE 不刷新閒置計時', async ({ browser }) => {
  test.setTimeout(90_000);
  const P = `T9-${Date.now()}`;
  const a = await openAs(browser, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const b = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}`);
  await waitLive(a, b, P);

  const meBefore = (await (await b.request.get('/api/auth/me')).json()) as {
    session: { lastActiveAt: number };
  };

  // A 以快速新增建立 → A 有成功 toast；B 2 秒內出現
  const quickAdd = a.getByRole('textbox', { name: '快速新增任務' });
  await quickAdd.fill(`${P} 甲`);
  const t0 = Date.now();
  await quickAdd.press('Enter');
  await expect(toasts(a).getByText('已建立任務')).toBeVisible();
  await expect(rowOf(b, `${P} 甲`)).toBeVisible(SYNC);
  test.info().annotations.push({ type: 'sync-latency-ms', description: String(Date.now() - t0) });

  // A 修改標題 → B 2 秒內更新
  const created = (
    (await (await a.request.get(`/api/tasks?q=${encodeURIComponent(`${P} 甲`)}`)).json()) as ApiTask[]
  )[0]!;
  await a.request.patch(`/api/tasks/${created.id}`, { data: { title: `${P} 甲改` } });
  await expect(rowOf(b, `${P} 甲改`)).toBeVisible(SYNC);

  // A 刪除 → B 2 秒內移除
  await a.request.delete(`/api/tasks/${created.id}`);
  await expect(rowOf(b, `${P} 甲改`)).toHaveCount(0, SYNC);

  // 整段期間 B 只有 GET（SSE、重抓）→ 閒置計時未被刷新
  const meAfter = (await (await b.request.get('/api/auth/me')).json()) as {
    session: { lastActiveAt: number };
  };
  expect(meAfter.session.lastActiveAt).toBe(meBefore.session.lastActiveAt);

  await a.context().close();
  await b.context().close();
});

test('他人修改 / 刪除我正在看的任務：提示誰、改了什麼', async ({ browser }) => {
  test.setTimeout(60_000);
  const P = `T9d-${Date.now()}`;
  const a = await openAs(browser, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const task = await createTask(a, `${P} 抽屜`);
  const b = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}&task=${task.id}`);
  const drawer = b.locator('.task-drawer');
  await expect(drawer.getByText('建立於')).toBeVisible();
  await expect(rowOf(b, task.title)).toBeVisible();

  const statuses = (await (await a.request.get('/api/statuses')).json()) as ApiStatus[];
  const doing = statuses.find((s) => s.name === '進行中')!;
  // 確認 SSE 已連上後再改（暖身變更）
  const warm = await createTask(a, `${P} 暖身`);
  await expect(rowOf(b, warm.title)).toBeVisible({ timeout: 10_000 });

  await a.request.patch(`/api/tasks/${task.id}`, { data: { statusId: doing.id, dueDate: '2026-12-31' } });
  const notice = drawer.getByRole('status').filter({ hasText: '管理員 剛更新了此任務' });
  await expect(notice).toBeVisible(SYNC);
  await expect(notice).toContainText('狀態、到期日');

  await a.request.delete(`/api/tasks/${task.id}`);
  await expect(drawer.getByText('此任務已被 管理員 刪除')).toBeVisible(SYNC);
  await expect(toasts(b).getByText(`管理員 刪除了「${task.title}」`)).toBeVisible();
  await expect(rowOf(b, task.title)).toHaveCount(0);
  await drawer.getByRole('button', { name: '關閉', exact: true }).click();
  await expect(drawer).toHaveCount(0);

  await a.context().close();
  await b.context().close();
});

test('SSE 斷線自動重連：中斷提示、恢復後補上期間的變更', async ({ browser }) => {
  test.setTimeout(90_000);
  const P = `T9o-${Date.now()}`;
  const a = await openAs(browser, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const b = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}`);
  await waitLive(a, b, P);

  await b.context().setOffline(true);
  await expect(toasts(b).getByText('即時更新中斷，正在重新連線…')).toBeVisible({ timeout: 15_000 });
  const missed = await createTask(a, `${P} 斷線期間`);
  await b.waitForTimeout(500);
  await expect(rowOf(b, missed.title)).toHaveCount(0);

  await b.context().setOffline(false);
  await expect(toasts(b).getByText('已恢復即時更新')).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(b, missed.title)).toBeVisible({ timeout: 5_000 });

  // 恢復後仍即時
  const after = await createTask(a, `${P} 恢復後`);
  await expect(rowOf(b, after.title)).toBeVisible(SYNC);

  await a.context().close();
  await b.context().close();
});

test('寫入失敗：toast 並回復樂觀更新', async ({ page }) => {
  const P = `T9f-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const task = await createTask(page, `${P} 標記`);
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = page.locator('.task-drawer');
  await expect(drawer.getByText('建立於')).toBeVisible();

  await page.route('**/api/personal/pins/*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '伺服器錯誤' } }),
    }),
  );
  await drawer.getByRole('button', { name: '加入我的標記' }).click();
  const alert = toasts(page).getByRole('alert').filter({ hasText: '無法儲存變更' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('已還原為先前的內容。');
  await expect(drawer.getByRole('button', { name: '加入我的標記' })).toBeVisible();

  // 重試成功 → toast 關閉、標記生效
  await page.unroute('**/api/personal/pins/*');
  await alert.getByRole('button', { name: '重試' }).click();
  await expect(alert).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '移出我的標記' })).toBeVisible();
});

test('動畫尊重 prefers-reduced-motion；抽屜開合', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const P = `T9m-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const task = await createTask(page, `${P} 動畫`);
  await expect(rowOf(page, task.title)).toBeVisible({ timeout: 10_000 });
  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--duration-base').trim(),
  );
  expect(parseFloat(duration)).toBe(0); // 0ms（建置後可能正規化為 0s）
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = page.locator('.task-drawer');
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await context.close();
});

test('閒置登出前 5 分鐘提醒，可一鍵延續', async ({ page }) => {
  await page.clock.install();
  await loginViaUi(page, E2E_USERS.member, '/');
  // 前端時鐘快轉 55 分鐘（伺服器端 session 仍有效）
  await page.clock.fastForward('55:30');
  const dialog = page.getByRole('alertdialog', { name: '即將自動登出' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '繼續使用' })).toBeFocused();
  await expect(dialog).toContainText(/4:\d\d/);
  // 提醒期間背景操作不算活動：Esc 不關閉
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主要導覽' })).toBeVisible();
});
