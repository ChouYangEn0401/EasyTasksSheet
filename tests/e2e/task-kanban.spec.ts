import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// T2 Kanban：欄 = 狀態、拖曳改狀態 / 順序（重整後保留）、點擊開詳情、欄尾快速新增、鍵盤拖曳、錯誤與空狀態
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; statusId: number; sortOrder: number };
type ApiStatus = { id: number; name: string };

const stamp = Date.now();
const T = { a: `看板A-${stamp}`, b: `看板B-${stamp}`, c: `看板C-${stamp}` };

const json = { 'Content-Type': 'application/json' };

async function listTasks(req: APIRequestContext): Promise<ApiTask[]> {
  return (await (await req.get('/api/tasks')).json()) as ApiTask[];
}
async function statusIdOf(req: APIRequestContext, name: string): Promise<number> {
  const list = (await (await req.get('/api/statuses')).json()) as ApiStatus[];
  return list.find((s) => s.name === name)!.id;
}
async function taskByTitle(req: APIRequestContext, title: string): Promise<ApiTask> {
  return (await listTasks(req)).find((t) => t.title === title)!;
}

const column = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const card = (scope: Page | Locator, title: string) =>
  scope.getByRole('listitem', { name: new RegExp(`^${title}，`) });
const cardTitles = (page: Page, name: string) =>
  column(page, name).locator('.kanban-card .kanban-card-title').allTextContents();

/** 鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽） */
async function key(page: Page, k: string) {
  await page.keyboard.press(k);
  await page.waitForTimeout(150);
}

async function pointerDrag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 90, { steps: 15 });
  await page.mouse.up();
}

test('看板：拖曳改狀態與順序、點擊開詳情、欄尾新增、鍵盤拖曳', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin, '/tasks/kanban');
  const req = page.request;
  const todo = await statusIdOf(req, '待辦');
  for (const [i, title] of [T.a, T.b, T.c].entries()) {
    await req.post('/api/tasks', {
      headers: json,
      data: { title, statusId: todo, sortOrder: 1000 + i, estimateHours: 2, dueDate: '2020-01-01' },
    });
  }
  // 以搜尋限定本測試建立的任務（DB 可能有其他 spec 留下的資料）；篩選於重整後保留
  await page.goto(`/tasks/kanban?q=${stamp}`);

  // 欄 = 狀態（依 sort_order）
  const board = page.getByRole('region', { name: '任務看板' });
  await expect(board).toBeVisible();
  for (const name of ['待辦', '進行中', '審查中', '完成']) await expect(column(page, name)).toBeVisible();
  const todoCol = column(page, '待辦');
  await expect(card(todoCol, T.a)).toBeVisible();
  await expect
    .poll(async () => (await cardTitles(page, '待辦')).filter((t) => t.includes(String(stamp))))
    .toEqual([T.a, T.b, T.c]);

  // 卡片內容：標題、負責人（未指派）、到期日（逾期）、預估工時、最後更新
  const cardA = card(todoCol, T.a);
  await expect(cardA.getByRole('img', { name: '未指派' })).toBeVisible();
  await expect(cardA.getByText('2020/01/01')).toBeVisible();
  await expect(cardA.getByText('2h', { exact: true })).toBeVisible();
  await expect(cardA.locator('time')).toHaveText('剛剛');
  await expect(column(page, '待辦').getByText(/Σ \d+h/)).toBeVisible();
  // 空欄提示
  await expect(column(page, '進行中').getByText('拖曳卡片到這裡')).toBeVisible();

  // 點擊開啟任務詳情，Esc 關閉
  const a = await taskByTitle(req, T.a);
  await cardA.click();
  await expect(page).toHaveURL(new RegExp(`task=${a.id}`));
  await expect(page.getByRole('dialog', { name: T.a })).toBeVisible();
  await expect(cardA).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 指標拖曳：A 跨欄到「進行中」→ 改狀態，重整後保留
  const doing = await statusIdOf(req, '進行中');
  await pointerDrag(page, cardA, column(page, '進行中'));
  await expect(card(column(page, '進行中'), T.a)).toBeVisible();
  await expect.poll(async () => (await taskByTitle(req, T.a)).statusId).toBe(doing);
  await page.reload();
  await expect(card(column(page, '進行中'), T.a)).toBeVisible();
  await expect(card(column(page, '待辦'), T.a)).toHaveCount(0);

  // 鍵盤拖曳：C 在欄內上移一格（Space 拿起 → ↑ → Space 放下），重整後順序保留
  const cardC = card(column(page, '待辦'), T.c);
  await cardC.focus();
  await key(page, 'Space');
  await expect(page.locator('[aria-live="assertive"]').filter({ hasText: '已拿起' })).toHaveText(
    new RegExp(`已拿起『${T.c}』，目前在 待辦 第 \\d+ 張`),
  );
  await key(page, 'ArrowUp');
  await key(page, 'Space');
  await expect
    .poll(async () => (await cardTitles(page, '待辦')).filter((t) => t.includes(String(stamp))))
    .toEqual([T.c, T.b]);
  await expect
    .poll(async () => {
      const b = await taskByTitle(req, T.b);
      const c = await taskByTitle(req, T.c);
      return c.sortOrder < b.sortOrder;
    })
    .toBe(true);
  await page.reload();
  // 重整後資料非同步載入：以自動重試斷言等待欄內順序穩定
  await expect
    .poll(async () => (await cardTitles(page, '待辦')).filter((t) => t.includes(String(stamp))))
    .toEqual([T.c, T.b]);

  // 鍵盤拖曳跨欄：B → 右移一欄（進行中）
  const cardB = card(column(page, '待辦'), T.b);
  await cardB.focus();
  await key(page, 'Space');
  await key(page, 'ArrowRight');
  await key(page, 'Space');
  await expect(card(column(page, '進行中'), T.b)).toBeVisible();
  await expect.poll(async () => (await taskByTitle(req, T.b)).statusId).toBe(doing);
  await expect(card(column(page, '進行中'), T.b)).toBeFocused();

  // Esc 取消：回原位、不送請求；優先於關閉抽屜
  const before = await taskByTitle(req, T.c);
  const cardC2 = card(column(page, '待辦'), T.c);
  await cardC2.click();
  await expect(page.getByRole('dialog', { name: T.c })).toBeVisible();
  await cardC2.focus();
  await key(page, 'Space');
  await key(page, 'ArrowRight');
  await expect(page.locator('[aria-live="assertive"]').filter({ hasText: '移到 進行中' })).toBeVisible();
  await key(page, 'Escape');
  await expect(card(column(page, '待辦'), T.c)).toBeVisible();
  await expect(page.locator('[aria-live="assertive"]').filter({ hasText: '已取消' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: T.c })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await taskByTitle(req, T.c)).toMatchObject({
    statusId: before.statusId,
    sortOrder: before.sortOrder,
  });

  // 鍵盤瀏覽：↑↓←→ 移動焦點、Enter 開啟詳情
  await card(column(page, '進行中'), T.a).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(card(column(page, '待辦'), T.c)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: T.c })).toBeVisible();
  await page.keyboard.press('Escape');
  // 等抽屜完全關閉（closeTask 會把 focus 拉回卡片），再操作 QuickAdd，避免 focus 被搶走
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]task=/);
  await expect(card(column(page, '待辦'), T.c)).toBeFocused();

  // 欄尾快速新增：帶入該欄狀態，出現在欄底
  const review = await statusIdOf(req, '審查中');
  const reviewAdd = page.getByRole('group', { name: '新增任務到「審查中」' }).getByRole('textbox');
  const newTitle = `看板新增-${stamp}`;
  await reviewAdd.fill(newTitle);
  await reviewAdd.press('Enter');
  await expect(card(column(page, '審查中'), newTitle)).toBeVisible();
  await expect(reviewAdd).toBeFocused();
  expect((await taskByTitle(req, newTitle)).statusId).toBe(review);

  // 儲存失敗：卡片回原欄 + 錯誤提示列
  await page.route('**/api/tasks/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: '伺服器錯誤' } }),
        })
      : route.continue(),
  );
  await pointerDrag(page, card(column(page, '審查中'), newTitle), column(page, '待辦'));
  await expect(
    page.getByRole('alert').filter({ hasText: `無法更新『${newTitle}』，已還原。` }),
  ).toBeVisible();
  await expect(card(column(page, '審查中'), newTitle)).toBeVisible();
  await page.unroute('**/api/tasks/*');

  // 登入前的 /api/auth/me 401 與刻意注入的 500 屬預期
  expect(errors.filter((e) => !/status of (401|500)/.test(e))).toEqual([]);
});

test('看板：篩選無結果、載入失敗', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.admin, '/tasks/kanban?q=no-such-task-zzz');
  await expect(page.getByText('沒有符合條件的任務')).toBeVisible();
  await page.getByRole('button', { name: '清除篩選' }).first().click();
  await expect(column(page, '待辦')).toBeVisible();

  // 狀態篩選：只渲染被選取的欄
  const todo = await statusIdOf(page.request, '待辦');
  await page.goto(`/tasks/kanban?status=${todo}`);
  await expect(column(page, '待辦')).toBeVisible();
  await expect(column(page, '進行中')).toHaveCount(0);

  await page.route('**/api/tasks', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: '伺服器錯誤' } }),
        })
      : route.continue(),
  );
  await page.goto('/tasks/kanban');
  await expect(page.getByText('載入失敗')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/tasks');
  await page.getByRole('button', { name: '重試' }).click();
  await expect(column(page, '待辦')).toBeVisible();
});

test('看板：1280 / 768 寬度不產生頁面層級水平捲軸', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.admin, '/tasks/kanban');
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(column(page, '待辦')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
  }
});
