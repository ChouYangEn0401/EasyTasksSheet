import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// T5 個人清單：三區、PinButton（個人頁 / Kanban / List）、自由待辦（新增 / 勾選 / 排序 / 刪除 / 重整保留）、唯讀檢視他人、403
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const TASK = `個人A-${stamp}`;
const TODO = { a: `待辦甲-${stamp}`, b: `待辦乙-${stamp}`, c: `待辦丙-${stamp}`, d: `待辦丁-${stamp}` };
const json = { 'Content-Type': 'application/json' };

type Me = { user: { id: number } };

async function meId(req: APIRequestContext): Promise<number> {
  return ((await (await req.get('/api/auth/me')).json()) as Me).user.id;
}

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const pinOf = (scope: Locator) => scope.getByRole('button', { name: /我的標記$/ });
const todoTitles = (page: Page) =>
  section(page, '自由待辦')
    .getByRole('list', { name: '自由待辦' })
    .locator('.pl-todo-title')
    .allTextContents();

async function key(page: Page, k: string) {
  await page.keyboard.press(k);
  await page.waitForTimeout(150);
}

test('個人清單：指派 / 標記 / 自由待辦，PinButton 於 Kanban 與 List 生效', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/me');
  const req = page.request;
  const me = await meId(req);
  const task = (await (
    await req.post('/api/tasks', {
      headers: json,
      data: { title: TASK, assigneeId: me, dueDate: '2020-01-02' },
    })
  ).json()) as { id: number };

  await page.goto('/me');
  const assigned = section(page, '指派給我的任務');
  const pinned = section(page, '我標記的任務');
  const todos = section(page, '自由待辦');

  // 指派給我：列含狀態、逾期到期日、最後更新
  const row = assigned.locator(`.pl-task-row[data-task-id="${task.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.pl-task-due')).toHaveClass(/is-overdue/);
  await expect(row.locator('time')).toHaveText('剛剛');

  // 我標記的：空狀態 → 點書籤 → 不需重整即出現，且不開啟詳情
  await expect(pinned.getByText('還沒有標記的任務')).toBeVisible();
  const pin = pinOf(row);
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect(pinned.locator(`.pl-task-row[data-task-id="${task.id}"]`)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBeNull();

  // 點列本體開啟任務詳情
  await row.getByRole('button', { name: `開啟任務：${TASK}` }).click();
  await expect(page).toHaveURL(new RegExp(`task=${task.id}`));
  await page.goto('/me');

  // 自由待辦：空狀態 → Enter 連續新增（新項目在最上方、輸入框保持 focus）
  const add = todos.getByRole('textbox', { name: '新增待辦' });
  await add.fill(TODO.a);
  await add.press('Enter');
  await expect(add).toHaveValue('');
  await expect(add).toBeFocused();
  await add.fill(TODO.b);
  await add.press('Enter');
  await expect(add).toHaveValue('');
  await add.fill(TODO.c);
  await add.press('Enter');
  await expect.poll(() => todoTitles(page)).toEqual([TODO.c, TODO.b, TODO.a]);
  await expect(todos.locator('.pl-todo-row time').first()).toBeVisible();

  // 鍵盤排序：把手 Space 拿起 → ↓ → Space 放下
  await todos.getByRole('button', { name: `拖曳排序：${TODO.c}` }).focus();
  await key(page, 'Space');
  await key(page, 'ArrowDown');
  await key(page, 'Space');
  await expect.poll(() => todoTitles(page)).toEqual([TODO.b, TODO.c, TODO.a]);
  // Alt+↑：直接上移一格
  await todos.getByRole('button', { name: `開啟待辦詳情：${TODO.a}` }).focus();
  await key(page, 'Alt+ArrowUp');
  await expect.poll(() => todoTitles(page)).toEqual([TODO.b, TODO.a, TODO.c]);

  // 點標題開啟詳情 inspector（?todo=<id>）改標題；Esc 關閉
  await todos.getByRole('button', { name: `開啟待辦詳情：${TODO.c}` }).click();
  await expect(page).toHaveURL(/todo=\d+/);
  const edit = page.locator('.pl-inspector').getByRole('textbox', { name: '標題' });
  await edit.fill(`${TODO.c}改`);
  await edit.press('Enter');
  await expect.poll(() => todoTitles(page)).toEqual([TODO.b, TODO.a, `${TODO.c}改`]);
  await edit.press('Escape'); // 先結束編輯
  await page.keyboard.press('Escape'); // 再關閉 inspector
  await expect(page.locator('.pl-inspector')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('todo')).toBeNull();

  // 勾選 → 移入「已完成」群組（預設收合）
  await todos.getByRole('checkbox', { name: `標為完成：${TODO.b}` }).click();
  await expect.poll(() => todoTitles(page)).toEqual([TODO.a, `${TODO.c}改`]);
  await expect(todos.getByRole('button', { name: '已完成 1' })).toHaveAttribute('aria-expanded', 'false');

  // 刪除
  await todos.getByRole('button', { name: `刪除待辦：${TODO.a}` }).click();
  await expect.poll(() => todoTitles(page)).toEqual([`${TODO.c}改`]);

  // 重整後順序與完成狀態保留
  await page.reload();
  await expect.poll(() => todoTitles(page)).toEqual([`${TODO.c}改`]);
  await todos.getByRole('button', { name: '已完成 1' }).click();
  await expect(todos.getByRole('checkbox', { name: `標為未完成：${TODO.b}` })).toBeChecked();
  await expect(pinned.locator(`.pl-task-row[data-task-id="${task.id}"]`)).toBeVisible();

  // Kanban：卡片上的 PinButton 反映同一份標記；點擊取消且不開詳情
  await page.goto(`/tasks/kanban?q=${stamp}`);
  const card = page.locator(`.kanban-card[data-task-id="${task.id}"]`);
  await expect(card).toBeVisible();
  const cardPin = pinOf(card);
  await expect(cardPin).toHaveAttribute('aria-pressed', 'true');
  await cardPin.click();
  await expect(cardPin).toHaveAttribute('aria-pressed', 'false');
  expect(new URL(page.url()).searchParams.get('task')).toBeNull();

  // List：列上的 PinButton 再標記一次，不開詳情
  await page.goto(`/tasks/list?q=${stamp}`);
  const listRow = page.locator(`.tl-row--task[data-task-id="${task.id}"]`);
  await listRow.hover();
  const listPin = pinOf(listRow);
  await expect(listPin).toHaveAttribute('aria-pressed', 'false');
  await listPin.click();
  await expect(listPin).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('task')).toBeNull();

  // 回到個人頁：標記清單已更新
  await page.goto('/me');
  await expect(pinned.locator(`.pl-task-row[data-task-id="${task.id}"]`)).toBeVisible();

  // API：不能改他人的清單（403）
  const admin = (await (await req.get('/api/users')).json()) as { id: number; username: string }[];
  const adminId = admin.find((u) => u.username === E2E_USERS.admin.username)!.id;
  const forbidden = await req.post(`/api/personal?user=${adminId}`, { headers: json, data: { title: 'x' } });
  expect(forbidden.status()).toBe(403);

  // 登入前查詢 /auth/me 的 401 屬預期
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('自由待辦小狀態與詳情 inspector：切換狀態、篩選、編輯細節，重整後仍在', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/me');
  const todos = section(page, '自由待辦');
  const add = todos.getByRole('textbox', { name: '新增待辦' });
  await add.fill(TODO.d);
  await add.press('Enter');
  const row = () => todos.locator('.pl-todo-row').filter({ hasText: TODO.d });
  const chip = (label: string) => row().getByRole('button', { name: `狀態：${label}，點擊變更：${TODO.d}` });
  const pick = async (from: string, to: string) => {
    await chip(from).click();
    await page.getByRole('menuitem', { name: to }).click();
  };
  await expect(chip('待處理')).toBeVisible();

  // 狀態 chip：進行中 → 延後（沉到「延後與取消」）→ 取消（標題刪除線）
  await pick('待處理', '進行中');
  await expect(chip('進行中')).toBeVisible();
  await expect.poll(() => todoTitles(page)).toContain(TODO.d);
  await pick('進行中', '延後');
  await expect.poll(() => todoTitles(page)).not.toContain(TODO.d);
  const parked = todos.getByRole('list', { name: '延後與取消' });
  await expect(parked.getByText(TODO.d)).toBeVisible();
  await pick('延後', '取消');
  await expect(row().locator('.pl-todo-title')).toHaveCSS('text-decoration-line', 'line-through');

  // 篩選：取消 → 只剩取消的；已完成 → 看到 b；全部
  await todos.getByRole('button', { name: /^篩選取消/ }).click();
  await expect(todos.locator('.pl-todo-row')).toHaveCount(1);
  await todos.getByRole('button', { name: /^篩選已完成/ }).click();
  await expect(todos.getByText(`${TODO.b}`)).toBeVisible();
  await todos.getByRole('button', { name: /^篩選全部/ }).click();

  // 清除已完成只清 done：取消的項目仍在
  // （此處不實際清除，避免影響後續測試；由後端 pytest 驗證）

  // inspector：標題旁開啟 → 狀態、到期日、細節
  await row()
    .getByRole('button', { name: `開啟待辦詳情：${TODO.d}` })
    .click();
  const insp = page.locator('.pl-inspector');
  await expect(insp).toBeVisible();
  const todoId = new URL(page.url()).searchParams.get('todo');
  expect(todoId).toMatch(/^\d+$/);
  await insp.getByRole('button', { name: '狀態', exact: true }).click();
  await page.getByRole('option', { name: '延後' }).click();
  await insp.getByRole('textbox', { name: '到期日', exact: true }).fill('2030-01-02');
  const detail = insp.getByRole('textbox', { name: '細節' });
  await detail.fill('第一行\n第二行：細節內容');
  await detail.press('Control+Enter');
  await expect(insp.getByText('已儲存')).toBeVisible();
  await expect(insp.getByText(/建立於/)).toBeVisible();
  await expect(insp.getByText(/更新於/)).toBeVisible();

  // 重整後 inspector 與內容仍在
  await page.reload();
  const insp2 = page.locator('.pl-inspector');
  await expect(insp2.getByRole('textbox', { name: '細節' })).toHaveValue('第一行\n第二行：細節內容');
  await expect(insp2.getByRole('textbox', { name: '到期日', exact: true })).toHaveValue('2030-01-02');
  await expect(insp2.getByRole('button', { name: '狀態', exact: true })).toContainText('延後');
  await expect(row().getByRole('button', { name: `狀態：延後，點擊變更：${TODO.d}` })).toBeVisible();

  // 刪除需確認
  await insp2.getByRole('button', { name: '刪除待辦' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(insp2).toBeVisible();
  await insp2.getByRole('button', { name: '刪除待辦' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '刪除', exact: true }).click();
  await expect(page.locator('.pl-inspector')).toHaveCount(0);
  await expect(row()).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('todo')).toBeNull();

  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('唯讀檢視他人清單：看得到內容，沒有任何可修改的控制項', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin, '/me');
  const users = (await (await page.request.get('/api/users')).json()) as { id: number; username: string }[];
  const memberId = users.find((u) => u.username === E2E_USERS.member.username)!.id;

  // 用成員切換選單前往
  await page.getByRole('button', { name: '檢視成員的清單' }).click();
  await page.getByRole('option', { name: E2E_USERS.member.displayName }).click();
  await expect(page).toHaveURL(new RegExp(`/me\\?user=${memberId}`));

  const name = E2E_USERS.member.displayName;
  await expect(page.getByText(`正在檢視 ${name} 的清單（唯讀）`)).toBeVisible();
  const todos = section(page, `${name} 的自由待辦`);
  await expect(todos.getByText(`${TODO.c}改`)).toBeVisible();
  await expect(todos.getByRole('textbox')).toHaveCount(0);
  await expect(todos.getByRole('button', { name: /^(刪除待辦|拖曳排序|編輯待辦|備註|狀態：)/ })).toHaveCount(
    0,
  );
  await expect(todos.getByRole('button', { name: '清除已完成' })).toHaveCount(0);
  await expect(todos.getByRole('checkbox').first()).toBeDisabled();
  await expect(section(page, `${name} 標記的任務`).getByText(TASK)).toBeVisible();
  await expect(section(page, `指派給 ${name} 的任務`).getByText(TASK)).toBeVisible();

  // 唯讀 inspector：看得到內容，沒有任何可編輯的欄位或刪除
  await todos.getByRole('button', { name: `開啟待辦詳情：${TODO.c}改` }).click();
  const insp = page.locator('.pl-inspector');
  await expect(insp.getByText('待辦詳情（唯讀）')).toBeVisible();
  await expect(insp.locator('.pl-insp-readonly').first()).toHaveText(`${TODO.c}改`);
  await expect(insp.getByRole('textbox')).toHaveCount(0);
  await expect(insp.getByRole('button', { name: /刪除/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(insp).toHaveCount(0);

  // PinButton 在他人清單上反映的是自己的標記（admin 沒標記）
  const row = section(page, `${name} 標記的任務`).locator('.pl-task-row').filter({ hasText: TASK });
  await expect(pinOf(row)).toHaveAttribute('aria-pressed', 'false');

  // 回到我的清單；不存在的成員顯示找不到
  await page.getByRole('link', { name: '回到我的清單' }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(section(page, '自由待辦')).toBeVisible();

  // 1280px 與 768px 無水平捲軸（以成員清單有資料的畫面檢查）
  await page.goto(`/me?user=${memberId}`);
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(todos.getByText(`${TODO.c}改`)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
  }

  await page.goto('/me?user=99999');
  await expect(page.getByText('找不到這位成員')).toBeVisible();

  // 登入前查詢 /auth/me 的 401 屬預期
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
  await ctx.close();
});
