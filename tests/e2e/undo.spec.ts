import { expect, test, type Browser, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi, type E2EUser } from '../helpers/e2e.ts';

// feat/undo：全站復原 / 重做（docs/design/undo.md）
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; statusId: number };
type ApiStatus = { id: number; name: string };

/** 設定 UNDO_SHOTS_DIR 時輸出截圖（1280 寬） */
const SHOTS = process.env.UNDO_SHOTS_DIR;
async function shot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  if (!SHOTS) return;
  await page.waitForTimeout(500); // 等進場動畫結束
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip });
}

async function openAs(browser: Browser, user: E2EUser, path: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await loginViaUi(page, user, path);
  return page;
}

async function createTask(page: Page, data: Record<string, unknown>): Promise<ApiTask> {
  const res = await page.request.post('/api/tasks', { data });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ApiTask;
}
async function getTask(page: Page, id: number) {
  return page.request.get(`/api/tasks/${id}`);
}
async function statusIdOf(page: Page, name: string): Promise<number> {
  const list = (await (await page.request.get('/api/statuses')).json()) as ApiStatus[];
  return list.find((s) => s.name === name)!.id;
}

const rowById = (page: Page, id: number) => page.locator(`.tl-row--task[data-task-id="${id}"]`);
const undoBtn = (page: Page) => page.locator('[data-undo-button="undo"]');
const redoBtn = (page: Page) => page.locator('[data-undo-button="redo"]');
const toasts = (page: Page) => page.getByRole('region', { name: '通知' });

/** 讓焦點離開輸入框（點主要區域的空白處） */
async function blur(page: Page) {
  await page.locator('#main').click({ position: { x: 5, y: 300 } });
}

test('清單就地改標題：Ctrl+Z 復原、Ctrl+Shift+Z 重做；輸入框內 Ctrl+Z 為原生行為；按鈕與 Tooltip', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const P = `UN${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const task = await createTask(page, { title: `${P} 原` });
  await page.goto(`/tasks/list?q=${P}`);
  const row = rowById(page, task.id);
  await expect(row).toBeVisible();

  // 沒有可復原項目：按鈕停用；Ctrl+Z 什麼都不做
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  // 就地改標題
  await row.locator('.tl-field--title .tl-title-text').click();
  const input = row.locator('.tl-field--title input');
  await input.fill(`${P} 新`);
  await input.press('Enter');
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 新`);
  await expect(undoBtn(page)).toBeEnabled();
  await expect(undoBtn(page)).toHaveAttribute('aria-label', `復原：修改『${P} 新』的標題`);

  // 焦點在輸入框內：Ctrl+Z 交給瀏覽器（不觸發全域復原）
  const quickAdd = page.getByRole('textbox', { name: '快速新增任務' });
  await quickAdd.click();
  await quickAdd.pressSequentially('abc');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 新`);
  await expect(undoBtn(page)).toHaveAttribute('aria-label', `復原：修改『${P} 新』的標題`);
  expect(((await (await getTask(page, task.id)).json()) as ApiTask).title).toBe(`${P} 新`);
  await quickAdd.fill('');
  await quickAdd.press('Escape');
  await blur(page);

  // Tooltip：下一步內容 + 快捷鍵
  await undoBtn(page).hover();
  await expect(page.getByRole('tooltip')).toHaveText(`復原：修改『${P} 新』的標題（Ctrl+Z）`);
  await shot(page, 'header-buttons', { x: 232, y: 0, width: 1048, height: 110 });
  await page.mouse.move(600, 500);

  // Ctrl+Z 復原
  await page.keyboard.press('Control+z');
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 原`);
  await expect(toasts(page).getByText(`已復原：修改『${P} 新』的標題`)).toBeVisible();
  await expect(toasts(page).getByRole('button', { name: '重做' })).toBeVisible();
  await expect
    .poll(async () => ((await (await getTask(page, task.id)).json()) as ApiTask).title)
    .toBe(`${P} 原`);
  await shot(page, 'toast-undone');
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeEnabled();

  // Ctrl+Shift+Z 重做
  await page.keyboard.press('Control+Shift+z');
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 新`);
  await expect(toasts(page).getByText(`已重做：修改『${P} 新』的標題`)).toBeVisible();
  await expect
    .poll(async () => ((await (await getTask(page, task.id)).json()) as ApiTask).title)
    .toBe(`${P} 新`);

  // 頂欄按鈕：復原 → toast 的「重做」鈕
  await undoBtn(page).click();
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 原`);
  await toasts(page).getByRole('button', { name: '重做' }).click();
  await expect(row.locator('.tl-field--title')).toHaveText(`${P} 新`);
  await expect
    .poll(async () => ((await (await getTask(page, task.id)).json()) as ApiTask).title)
    .toBe(`${P} 新`);

  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('建立任務 → 復原（消失）→ 重做（回來）；刪除 → 復原（回來）', async ({ page }) => {
  test.setTimeout(90_000);
  // 頁面 console 不可出現 404（抽屜離場中重抓已刪除任務的子資源）；expect.poll 用 page.request，不經過頁面 console
  const errors = collectErrors(page);
  const P = `UC${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, `/tasks/list?q=${P}`);
  await expect(page.getByText('沒有符合條件的任務')).toBeVisible();

  // 快速新增
  const quickAdd = page.getByRole('textbox', { name: '快速新增任務' });
  await quickAdd.fill(`${P} 新建`);
  await quickAdd.press('Enter');
  const rows = page.locator('.tl-row--task:not([data-temp])');
  await expect(rows).toHaveCount(1);
  const id = Number(await rows.first().getAttribute('data-task-id'));
  await quickAdd.press('Escape');
  await blur(page);
  await expect(undoBtn(page)).toHaveAttribute('aria-label', `復原：建立任務『${P} 新建』`);

  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(0);
  await expect.poll(async () => (await getTask(page, id)).status()).toBe(404);

  await page.keyboard.press('Control+Shift+z');
  await expect(rows).toHaveCount(1);
  await expect.poll(async () => (await getTask(page, id)).status()).toBe(200);

  // 刪除（Drawer → 確認）→ 復原
  const row = rowById(page, id);
  await row.hover();
  await row.getByRole('button', { name: '開啟' }).click();
  const drawer = page.getByRole('dialog', { name: `${P} 新建` });
  await drawer.getByRole('button', { name: '更多動作' }).click();
  await page.getByRole('menuitem', { name: '刪除任務' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '刪除', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await blur(page);
  await expect(undoBtn(page)).toHaveAttribute('aria-label', `復原：刪除任務『${P} 新建』`);

  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(1);
  await expect.poll(async () => (await getTask(page, id)).status()).toBe(200);
  // Ctrl+Y 也可重做（再次刪除）
  await page.keyboard.press('Control+y');
  await expect(rows).toHaveCount(0);
  await expect.poll(async () => (await getTask(page, id)).status()).toBe(404);
  await page.waitForTimeout(500);
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('看板拖曳改狀態 → 復原 → 回到原欄', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const P = `UK${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/kanban');
  const todo = await statusIdOf(page, '待辦');
  const doing = await statusIdOf(page, '進行中');
  const task = await createTask(page, { title: `${P} 卡`, statusId: todo });
  await page.goto(`/tasks/kanban?q=${P}`);

  const column = (name: string) => page.getByRole('group', { name, exact: true });
  const card = column('待辦').getByRole('listitem', { name: new RegExp(`^${P} 卡，`) });
  await expect(card).toBeVisible();
  const a = (await card.boundingBox())!;
  const b = (await column('進行中').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 90, { steps: 15 });
  await page.mouse.up();

  await expect(column('進行中').getByRole('listitem', { name: new RegExp(`^${P} 卡，`) })).toBeVisible();
  await expect
    .poll(async () => ((await (await getTask(page, task.id)).json()) as ApiTask).statusId)
    .toBe(doing);
  await expect(undoBtn(page)).toHaveAttribute('aria-label', `復原：把『${P} 卡』移到『進行中』`);

  await page.keyboard.press('Control+z');
  await expect(column('待辦').getByRole('listitem', { name: new RegExp(`^${P} 卡，`) })).toBeVisible();
  await expect
    .poll(async () => ((await (await getTask(page, task.id)).json()) as ApiTask).statusId)
    .toBe(todo);
  await expect(toasts(page).getByText(`已復原：把『${P} 卡』移到『進行中』`)).toBeVisible();
});

test('A 修改後 B 又改同欄位：A 復原時出現衝突對話框（略過 / 仍要復原）', async ({ browser }) => {
  test.setTimeout(120_000);
  const P = `UX${Date.now()}`;
  const a = await openAs(browser, E2E_USERS.admin, '/tasks/list');
  const task = await createTask(a, { title: `${P} 原` });
  await a.goto(`/tasks/list?q=${P}`);
  const b = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}`);
  const rowA = rowById(a, task.id);

  const editTitle = async (value: string) => {
    await rowA.locator('.tl-field--title .tl-title-text').click();
    const input = rowA.locator('.tl-field--title input');
    await input.fill(value);
    await input.press('Enter');
    await expect(rowA.locator('.tl-field--title')).toHaveText(value);
    await blur(a);
  };
  const patchAsB = async (title: string) => {
    const res = await b.request.patch(`/api/tasks/${task.id}`, { data: { title } });
    expect(res.ok()).toBeTruthy();
    await expect(rowA.locator('.tl-field--title')).toHaveText(title, { timeout: 10_000 });
  };

  // ① 略過這項：不覆蓋，該筆從堆疊移除
  await editTitle(`${P} A改`);
  await patchAsB(`${P} B改`);
  await a.keyboard.press('Control+z');
  const dialog = a.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('「標題」已被別人修改');
  await expect(dialog).toContainText(
    `這個欄位在你修改之後被別人改過（現在是『${P} B改』）。仍要復原並覆蓋嗎？`,
  );
  await shot(a, 'conflict-dialog');
  await dialog.getByRole('button', { name: '略過這項' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowA.locator('.tl-field--title')).toHaveText(`${P} B改`);
  await expect(undoBtn(a)).toBeDisabled();
  expect(((await (await getTask(a, task.id)).json()) as ApiTask).title).toBe(`${P} B改`);

  // ② 仍要復原：覆蓋回 A 修改前的值
  await editTitle(`${P} A再改`);
  await patchAsB(`${P} B再改`);
  await a.keyboard.press('Control+z');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '仍要復原' }).click();
  await expect(rowA.locator('.tl-field--title')).toHaveText(`${P} B改`);
  await expect
    .poll(async () => ((await (await getTask(a, task.id)).json()) as ApiTask).title)
    .toBe(`${P} B改`);

  // 他人的變更不入 A 的堆疊；B 自己沒有可復原項目
  await expect(undoBtn(b)).toBeDisabled();

  // 任務被別人刪除後復原：提示「此任務已不存在」並移除該筆
  await editTitle(`${P} 最後`);
  await b.request.delete(`/api/tasks/${task.id}`);
  await expect(rowA).toHaveCount(0, { timeout: 10_000 });
  await a.keyboard.press('Control+z');
  await expect(toasts(a).getByText('此任務已不存在')).toBeVisible();
  await expect(undoBtn(a)).toBeDisabled();

  await a.context().close();
  await b.context().close();
});
