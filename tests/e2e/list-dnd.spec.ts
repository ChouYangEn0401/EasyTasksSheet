import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 清單拖曳（docs/design/task-list.md §13）：拖到別的群組改狀態 / 負責人、空群組、收合群組、鍵盤拖曳、
// 排序中限制、權限；以及表格撐滿寬度（§10）。截圖於設定 LIST_DND_SHOTS 時輸出。
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; statusId: number; assigneeId: number | null; sortOrder: number };

const stamp = Date.now();
const T = { a: `拖曳A-${stamp}`, b: `拖曳B-${stamp}`, c: `拖曳C-${stamp}`, d: `拖曳D-${stamp}` };
const SHOTS = process.env.LIST_DND_SHOTS;
const json = { 'Content-Type': 'application/json' };

async function listTasks(req: APIRequestContext): Promise<ApiTask[]> {
  return (await (await req.get(`/api/tasks?q=${stamp}`)).json()) as ApiTask[];
}
async function taskByTitle(req: APIRequestContext, title: string): Promise<ApiTask> {
  return (await listTasks(req)).find((t) => t.title === title)!;
}
async function statusIdOf(req: APIRequestContext, name: string): Promise<number> {
  const list = (await (await req.get('/api/statuses')).json()) as { id: number; name: string }[];
  return list.find((s) => s.name === name)!.id;
}
async function userIdOf(req: APIRequestContext, username: string): Promise<number> {
  const list = (await (await req.get('/api/users')).json()) as { id: number; username: string }[];
  return list.find((u) => u.username === username)!.id;
}

const row = (page: Page, title: string) => page.locator('.tl-row--task', { hasText: title });
const handle = (page: Page, title: string) => row(page, title).locator('.tl-drag-handle');
const groupRow = (page: Page, name: string) => page.locator('.tl-row--group', { hasText: name });
const insertRowOf = (page: Page, name: string) =>
  groupRow(page, name).locator('xpath=following-sibling::div[contains(@class,"tl-row--insert")][1]');

/** 列所在群組（往上找最近的群組列）的文字 */
async function groupOf(page: Page, title: string): Promise<string> {
  return row(page, title).evaluate((el) => {
    let n = el.previousElementSibling;
    while (n && !n.classList.contains('tl-row--group')) n = n.previousElementSibling;
    return n?.textContent ?? '';
  });
}

/** 鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽） */
async function key(page: Page, k: string) {
  await page.keyboard.press(k);
  await page.waitForTimeout(150);
}

/** 以 page.mouse 分段移動拖曳（dnd-kit 需要多個 pointermove）；y 為目標內的相對位置 0–1 */
async function pointerDrag(
  page: Page,
  from: Locator,
  to: Locator,
  { y = 0.5, shot, beforeDrop }: { y?: number; shot?: string; beforeDrop?: () => Promise<void> } = {},
) {
  await from.locator('xpath=ancestor::div[@role="row"][1]').hover();
  const a = (await from.boundingBox())!;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 4, ay + 8, { steps: 4 });
  const b = (await to.boundingBox())!;
  const bx = b.x + Math.min(240, b.width / 2);
  const by = b.y + b.height * y;
  await page.mouse.move(bx, by, { steps: 16 });
  await page.mouse.move(bx + 3, by, { steps: 3 });
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}` });
  if (beforeDrop) await beforeDrop();
  await page.mouse.up();
  // dnd-kit 在放下後約 50ms 內會攔下接著的 click（避免拖曳觸發點擊），稍等再進行下一步
  await page.waitForTimeout(150);
}

async function newLoggedIn(browser: Browser, user: (typeof E2E_USERS)[keyof typeof E2E_USERS], next: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await loginViaUi(page, user, next);
  return { context, page };
}

test('清單拖曳：滑鼠拖到空群組 / 完成 / 收合群組，重整後保留；組內調整順序', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const req = page.request;
  const doing = await statusIdOf(req, '進行中');
  const todo = await statusIdOf(req, '待辦');
  const done = await statusIdOf(req, '完成');
  const review = await statusIdOf(req, '審查中');
  for (const [i, title] of [T.a, T.b, T.c, T.d].entries()) {
    await req.post('/api/tasks', { headers: json, data: { title, statusId: doing, sortOrder: 1000 + i } });
  }
  await page.goto(`/tasks/list?q=${stamp}`);
  await expect(row(page, T.a)).toBeVisible();
  await expect(groupRow(page, '待辦')).toContainText('0');

  // 把手：hover 才顯示，有中文標籤
  await row(page, T.a).hover();
  await expect(handle(page, T.a)).toHaveAttribute('aria-label', `拖曳「${T.a}」`);
  await expect(handle(page, T.a)).toHaveCSS('opacity', '1');

  // 進行中 → 空的「待辦」群組（放在「新增任務」列上）
  await pointerDrag(page, handle(page, T.a), insertRowOf(page, '待辦'), {
    shot: 'dragging-1280.png',
    beforeDrop: async () => {
      await expect(page.locator('.tl-drag-overlay')).toContainText(T.a);
      await expect(groupRow(page, '待辦')).toHaveAttribute('data-drop-target', 'true');
      await expect(insertRowOf(page, '待辦')).toHaveAttribute('data-drop', 'before');
    },
  });
  await expect.poll(async () => (await taskByTitle(req, T.a)).statusId).toBe(todo);
  await expect.poll(() => groupOf(page, T.a)).toContain('待辦');
  await expect(page.getByText('已移到「待辦」')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dropped-1280.png` });
  await page.reload();
  await expect(row(page, T.a)).toBeVisible();
  expect(await groupOf(page, T.a)).toContain('待辦');

  // 進行中 → 「完成」群組標頭 → 狀態 done
  await pointerDrag(page, handle(page, T.b), groupRow(page, '完成'));
  await expect.poll(async () => (await taskByTitle(req, T.b)).statusId).toBe(done);
  await expect(row(page, T.b)).toHaveAttribute('data-done', 'true');

  // 組內調整順序：D 拖到 C 之前（C 列上半部）
  await pointerDrag(page, handle(page, T.d), row(page, T.c), { y: 0.2 });
  await expect
    .poll(async () => {
      const c = await taskByTitle(req, T.c);
      const d = await taskByTitle(req, T.d);
      return d.sortOrder < c.sortOrder && d.statusId === doing;
    })
    .toBe(true);

  // 收合群組標頭也可放：放下後保持收合並提示
  await groupRow(page, '審查中').locator('.tl-group-cell').click();
  await expect(groupRow(page, '審查中')).toHaveAttribute('aria-expanded', 'false');
  await pointerDrag(page, handle(page, T.c), groupRow(page, '審查中'));
  await expect.poll(async () => (await taskByTitle(req, T.c)).statusId).toBe(review);
  await expect(page.getByText('已移到「審查中」')).toBeVisible();
  await expect(groupRow(page, '審查中')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, T.c)).toHaveCount(0);
  await groupRow(page, '審查中').locator('.tl-group-cell').click();
  await expect(row(page, T.c)).toBeVisible();

  // 拖到清單外放開 = 取消
  const before = await taskByTitle(req, T.d);
  await pointerDrag(page, handle(page, T.d), page.getByRole('navigation', { name: '主要導覽' }));
  await page.waitForTimeout(300);
  expect(await taskByTitle(req, T.d)).toMatchObject({
    statusId: before.statusId,
    sortOrder: before.sortOrder,
  });

  // 儲存失敗：還原 + 提示列
  await page.route('**/api/tasks/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: '伺服器錯誤' } }),
        })
      : route.continue(),
  );
  await pointerDrag(page, handle(page, T.d), insertRowOf(page, '完成'));
  await expect(page.getByRole('alert').filter({ hasText: `無法移動『${T.d}』，已還原。` })).toBeVisible();
  await expect.poll(() => groupOf(page, T.d)).toContain('進行中');
  await page.unroute('**/api/tasks/*');

  expect(errors.filter((e) => !/status of (401|500)/.test(e))).toEqual([]);
});

test('清單拖曳：鍵盤（Space 拿起、↑↓ 移動、Space 放下、Esc 取消）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${stamp}`);
  const req = page.request;
  const todo = await statusIdOf(req, '待辦');
  // 目前：待辦 [A]、進行中 [D]、審查中 [C]、完成 [B]
  await expect(row(page, T.d)).toBeVisible();
  const live = page.locator('.tl-sr-only[aria-live="assertive"]');

  // Esc 取消：不送請求
  const before = await taskByTitle(req, T.d);
  await handle(page, T.d).focus();
  await key(page, 'Space');
  await expect(live).toHaveText(new RegExp(`已拿起『${T.d}』，目前在 進行中 第 1 筆`));
  await key(page, 'ArrowUp');
  await expect(live).toHaveText('移到 待辦 第 2 筆');
  await key(page, 'Escape');
  await expect(live).toHaveText('已取消，回到 進行中 第 1 筆');
  expect(await taskByTitle(req, T.d)).toMatchObject({
    statusId: before.statusId,
    sortOrder: before.sortOrder,
  });

  // ↑ 兩次 → 待辦第 1 筆（A 之前）→ Space 放下
  await handle(page, T.d).focus();
  await key(page, 'Space');
  await key(page, 'ArrowUp');
  await key(page, 'ArrowUp');
  await expect(live).toHaveText('移到 待辦 第 1 筆');
  await key(page, 'Space');
  await expect(live).toHaveText('已放到 待辦 第 1 筆');
  await expect.poll(async () => (await taskByTitle(req, T.d)).statusId).toBe(todo);
  await expect
    .poll(async () => (await taskByTitle(req, T.d)).sortOrder < (await taskByTitle(req, T.a)).sortOrder)
    .toBe(true);
  await expect(handle(page, T.d)).toBeFocused();
  // 方向鍵仍可在表格內移動（把手為任務列第一格）
  await page.keyboard.press('ArrowRight');
  await expect(row(page, T.d).locator('.tl-done')).toBeFocused();
});

test('清單拖曳：排序中可跨群組、群組內順序停用', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${stamp}&sort=title&dir=asc`);
  const req = page.request;
  const review = await statusIdOf(req, '審查中');
  await expect(row(page, T.a)).toBeVisible();
  // 待辦 [A, D]（依標題排序）
  const a0 = await taskByTitle(req, T.a);
  const d0 = await taskByTitle(req, T.d);

  // 群組內：D 拖到 A 之前 → 不變（浮層提示排序中）
  await pointerDrag(page, handle(page, T.d), row(page, T.a), {
    y: 0.2,
    beforeDrop: async () => {
      await expect(page.locator('.tl-drag-overlay')).toContainText('排序中，無法手動調整順序');
      await expect(row(page, T.a)).not.toHaveAttribute('data-drop', 'before');
    },
  });
  await page.waitForTimeout(300);
  expect((await taskByTitle(req, T.a)).sortOrder).toBe(a0.sortOrder);
  expect(await taskByTitle(req, T.d)).toMatchObject({ statusId: d0.statusId, sortOrder: d0.sortOrder });

  // 跨群組：D → 審查中（只改狀態，不改 sort_order）
  await pointerDrag(page, handle(page, T.d), groupRow(page, '審查中'));
  await expect.poll(async () => (await taskByTitle(req, T.d)).statusId).toBe(review);
  expect((await taskByTitle(req, T.d)).sortOrder).toBe(d0.sortOrder);

  // 把手的 Tooltip 說明
  await row(page, T.a).hover();
  await handle(page, T.a).hover();
  await expect(page.getByRole('tooltip')).toHaveText('排序中，無法手動調整順序；仍可拖到其他群組');
});

test('清單拖曳：依負責人分組拖到另一人 / 未指派', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const req = page.request;
  const member = await userIdOf(req, E2E_USERS.member.username);
  const a = await taskByTitle(req, T.a);
  await req.patch(`/api/tasks/${a.id}`, { headers: json, data: { assigneeId: member } });
  await page.goto(`/tasks/list?q=${stamp}&group=assignee`);
  await expect(groupRow(page, E2E_USERS.member.displayName)).toBeVisible();
  await expect(groupRow(page, '未指派')).toBeVisible();

  // 未指派的 B → 一般成員
  await pointerDrag(page, handle(page, T.b), insertRowOf(page, E2E_USERS.member.displayName));
  await expect.poll(async () => (await taskByTitle(req, T.b)).assigneeId).toBe(member);
  await expect.poll(() => groupOf(page, T.b)).toContain(E2E_USERS.member.displayName);

  // A → 未指派（null）
  await pointerDrag(page, handle(page, T.a), groupRow(page, '未指派'));
  await expect.poll(async () => (await taskByTitle(req, T.a)).assigneeId).toBe(null);
});

test('清單拖曳：沒有 tasks.edit 看不到把手', async ({ browser }) => {
  const root = await newLoggedIn(browser, E2E_USERS.admin, '/tasks/list');
  try {
    const res = await root.page.request.put('/api/admin/permissions', {
      headers: json,
      data: { changes: [{ role: 'user', capability: 'tasks.edit', allowed: false }] },
    });
    expect(res.status()).toBe(200);
    const member = await newLoggedIn(browser, E2E_USERS.member, `/tasks/list?q=${stamp}`);
    await expect(row(member.page, T.a)).toBeVisible();
    await row(member.page, T.a).hover();
    await expect(member.page.locator('.tl-drag-handle')).toHaveCount(0);
    await member.context.close();
    // admin（root）仍有把手
    await root.page.goto(`/tasks/list?q=${stamp}`);
    await expect(handle(root.page, T.a)).toHaveCount(1);
  } finally {
    await root.page.request.put('/api/admin/permissions', {
      headers: json,
      data: { changes: [{ role: 'user', capability: 'tasks.edit', allowed: true }] },
    });
    await root.context.close();
  }
});

test('清單表格撐滿寬度：1280 / 1440 / 1920 無水平捲軸；抽屜開啟時只讓出被蓋住的寬度', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${stamp}`);
  const scroll = page.locator('.tl-scroll');
  const measure = () =>
    scroll.evaluate((el) => {
      const head = el.querySelector('.tl-row--header')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        overflow: el.scrollWidth - el.clientWidth,
        gap: r.left + el.clientLeft + el.clientWidth - head.right,
      };
    });
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(row(page, T.a)).toBeVisible();
    await expect.poll(async () => (await measure()).overflow, `${width}px 水平捲軸`).toBeLessThanOrEqual(0);
    // 表頭撐滿捲動區（右側沒有空白）
    expect((await measure()).gap, `${width}px 右側空白`).toBeLessThanOrEqual(1);
    // 「+」新增欄位按鈕在最右
    const add = (await page.locator('.tl-hcell--add button').boundingBox())!;
    const box = (await scroll.boundingBox())!;
    expect(box.x + box.width - (add.x + add.width), `${width}px ＋ 位置`).toBeLessThan(40);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-${width}.png` });
  }

  // 1920 開抽屜：表格右緣貼齊抽屜左緣，不出現水平捲軸
  await row(page, T.a).hover();
  await row(page, T.a).getByRole('button', { name: '開啟' }).click();
  await expect(page.getByRole('dialog', { name: T.a })).toBeVisible();
  await page.waitForTimeout(400);
  await expect.poll(async () => (await measure()).overflow).toBeLessThanOrEqual(0);
  const drawer = (await page.locator('.task-drawer').boundingBox())!;
  const head = (await page.locator('.tl-row--header').boundingBox())!;
  expect(Math.abs(head.x + head.width - drawer.x)).toBeLessThanOrEqual(2);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-drawer-1920.png` });
  await page.keyboard.press('Escape');

  // 768：既有排版（區塊內捲動），頁面本身不產生水平捲軸
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(row(page, T.a)).toBeVisible();
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(0);
  await expect(handle(page, T.a)).toHaveCSS('opacity', '1');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/table-768.png` });
  if (SHOTS) {
    // 768 拖曳中截圖（放到清單外取消，不改資料）
    await pointerDrag(page, handle(page, T.a), groupRow(page, '進行中'), {
      shot: 'dragging-768.png',
      beforeDrop: () => page.keyboard.press('Escape'),
    });
  }
});
