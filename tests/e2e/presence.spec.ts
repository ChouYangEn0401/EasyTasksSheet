import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi, type E2EUser } from '../helpers/e2e.ts';

// feat/presence：三位使用者同時在線（docs/design/presence.md、docs/multi-user.md）
// E2E 伺服器以 PRESENCE_ONLINE_SECONDS=10、PRESENCE_IDLE_SECONDS=25 啟動（playwright.config.ts）
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string };

const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300); // 等進場動畫結束
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openAs(browser: Browser, user: E2EUser, path: string, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await loginViaUi(page, user, path);
  return page;
}

const stackOf = (page: Page) => page.getByRole('group', { name: '在線成員' });
const rowOf = (page: Page, title: string) => page.locator('.tl-row--task', { hasText: title });

test('三人同時在線：頭像堆疊、hover 卡片、抽屜提示、清單小頭像、關閉後轉離線', async ({ browser }) => {
  test.setTimeout(150_000);
  const P = `PR-${Date.now()}`;
  const width = Number(process.env.PRESENCE_SHOT_WIDTH ?? 1280);

  // A：甘特圖
  const a = await openAs(browser, E2E_USERS.admin, '/tasks/gantt', width);
  const created = await a.request.post('/api/tasks', { data: { title: `${P} ntu ranking new workflow` } });
  const task = (await created.json()) as ApiTask;

  // B：開啟任務抽屜
  const b = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}&task=${task.id}`, width);
  await expect(b.locator('.task-drawer').getByText('建立於')).toBeVisible();

  // C：在清單就地編輯同一任務的標題（尚未送出）
  const c = await openAs(browser, E2E_USERS.peer, `/tasks/list?q=${P}`, width);
  // 以 id 定位列（編輯中時列文字會變成輸入框）
  const row = c.locator(`.tl-row--task[data-task-id="${task.id}"]`);
  await expect(row).toBeVisible();
  // C 的清單列：B 正在看 → 小頭像
  await expect(row.locator('.pr-dots')).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.pr-dots')).toHaveAttribute('aria-label', '一般成員 也正在看這個任務');
  await shot(c, `${width}-list-mini-avatars`);

  await row.locator('.tl-field--title .tl-title-text').click();
  const input = row.locator('.tl-field--title input');
  await expect(input).toBeFocused();
  await input.fill(`${P} 晴恩改的標題`);

  // A：頂欄堆疊出現 B、C，hover C 顯示「正在編輯」
  const stack = stackOf(a);
  const peerBtn = stack.getByRole('button', { name: /^晴恩，/ });
  const memberBtn = stack.getByRole('button', { name: /^一般成員，/ });
  await expect(peerBtn).toBeVisible({ timeout: 10_000 });
  await expect(memberBtn).toBeVisible();
  await a.mouse.move(10, 400);
  await shot(a, `${width}-header-stack`);
  await peerBtn.hover();
  const card = a.locator('.pr-card');
  await expect(card).toContainText('晴恩');
  await expect(card).toContainText(`正在編輯「${task.title}」`, { timeout: 10_000 });
  await shot(a, `${width}-hover-card-editing`);
  await memberBtn.hover();
  await expect(card).toContainText(`看「${task.title}」`);
  await shot(a, `${width}-hover-card-viewing`);

  // B：抽屜提示條「晴恩 正在編輯」；B 的清單列也有 C 的小頭像
  const hint = b.locator('.task-drawer .pr-hint');
  await expect(hint.locator('.pr-hint-text')).toHaveText('晴恩 正在編輯', { timeout: 10_000 });
  await expect(rowOf(b, task.title).locator('.pr-mini[data-mode="editing"]')).toBeVisible();
  await shot(b, `${width}-drawer-hint`);

  // A：全部成員面板
  await a.mouse.move(10, 400);
  await stack.getByRole('button', { name: /^全部成員/ }).click();
  const panel = a.getByRole('dialog', { name: '全部成員' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pr-row', { hasText: '晴恩' })).toContainText('正在編輯');
  await expect(panel.locator('.pr-row', { hasText: '一般成員' })).toContainText(task.title);
  await expect(panel.getByRole('checkbox', { name: '隱藏我的動態' })).toBeVisible();
  await shot(a, `${width}-panel`);

  // C 送出 → B 的抽屜即時更新標題；提示條回到「也正在看」或消失
  await input.press('Enter');
  const newTitle = `${P} 晴恩改的標題`;
  await expect(b.locator('.task-drawer h2')).toContainText(newTitle, { timeout: 5_000 });
  await expect(b.locator('.task-drawer .pr-hint', { hasText: '正在編輯' })).toHaveCount(0, {
    timeout: 10_000,
  });

  // C：看得到 A 在甘特圖
  await stackOf(c)
    .getByRole('button', { name: /^全部成員/ })
    .click();
  await expect(
    c.getByRole('dialog', { name: '全部成員' }).locator('.pr-row', { hasText: '管理員' }),
  ).toContainText('甘特圖');

  // C 關閉 → A 的面板在 60 秒內顯示晴恩離線，並帶「最後看的是」
  await c.context().close();
  const offline = panel.locator('.pr-row[data-status="offline"]', { hasText: '晴恩' });
  await expect(offline).toBeVisible({ timeout: 60_000 });
  await expect(offline).toContainText('最後上線');
  await expect(offline).toContainText('最後看的是 清單');
  await shot(a, `${width}-panel-offline`);

  await a.context().close();
  await b.context().close();
});

test('看板卡片：他人開啟中的任務顯示小頭像', async ({ browser }) => {
  test.setTimeout(60_000);
  const P = `PRK-${Date.now()}`;
  const width = Number(process.env.PRESENCE_SHOT_WIDTH ?? 1280);
  const a = await openAs(browser, E2E_USERS.admin, `/tasks/kanban?q=${P}`, width);
  const task = (await (
    await a.request.post('/api/tasks', { data: { title: `${P} 看板任務` } })
  ).json()) as ApiTask;
  const c = await openAs(browser, E2E_USERS.peer, `/tasks/kanban?q=${P}&task=${task.id}`, width);
  await expect(c.locator('.task-drawer').getByText('建立於')).toBeVisible();
  const card = a.locator(`.kanban-card[data-task-id="${task.id}"]`);
  await expect(card.locator('.pr-dots')).toHaveAttribute('aria-label', '晴恩 也正在看這個任務', {
    timeout: 10_000,
  });
  await shot(a, `${width}-kanban-sticker`);
  await a.context().close();
  await c.context().close();
});

test('隱藏我的動態：別人只看到在線，看不到在看什麼', async ({ browser }) => {
  test.setTimeout(60_000);
  const a = await openAs(browser, E2E_USERS.admin, '/feedback');
  const c = await openAs(browser, E2E_USERS.peer, '/feedback');
  const stack = stackOf(a);
  await expect(stack.getByRole('button', { name: /^晴恩，/ })).toHaveAccessibleName(/問題回饋/, {
    timeout: 10_000,
  });

  await stackOf(c)
    .getByRole('button', { name: /^全部成員/ })
    .click();
  await c.getByRole('checkbox', { name: '隱藏我的動態' }).check();
  await expect(c.getByText('大家只會看到你在線上，不會看到你在看什麼')).toBeVisible();
  await expect(stack.getByRole('button', { name: /^晴恩，/ })).toHaveAccessibleName(
    /^晴恩，(在線，在線上|閒置，暫時離開一下)$/,
    { timeout: 10_000 },
  );
  // 還原（localStorage 屬於 C 的 context，關閉即清除；仍明確取消）
  await c.getByRole('checkbox', { name: '隱藏我的動態' }).uncheck();
  await a.context().close();
  await c.context().close();
});

test('presence 不延長閒置登出（page.clock）', async ({ page }) => {
  test.setTimeout(60_000);
  const presencePuts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/presence') presencePuts.push(r.url());
  });
  await page.clock.install();
  await loginViaUi(page, E2E_USERS.member, '/feedback');
  await expect(page).toHaveURL(/\/feedback$/);
  const before = (await (await page.request.get('/api/auth/me')).json()) as {
    session: { lastActiveAt: number };
  };

  // 持續移動滑鼠（presence 視為活動、會送 keepalive；閒置計時只認點擊 / 鍵盤 / 滾輪）
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(200 + i * 10, 300);
    await page.clock.fastForward('05:00');
  }
  await expect.poll(() => presencePuts.length).toBeGreaterThanOrEqual(3);
  // 伺服器端：presence 回報不刷新 last_active_at
  const mid = (await (await page.request.get('/api/auth/me')).json()) as {
    session: { lastActiveAt: number };
  };
  expect(mid.session.lastActiveAt).toBe(before.session.lastActiveAt);

  for (let i = 0; i < 10; i++) {
    await page.mouse.move(300 + i * 10, 320);
    await page.clock.fastForward('05:00');
  }
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  expect(presencePuts.length).toBeGreaterThanOrEqual(5);
});
