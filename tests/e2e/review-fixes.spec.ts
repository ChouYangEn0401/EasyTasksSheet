import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi, type E2EUser } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// R2 前端審查修正：復原堆疊、拖曳 Esc、標題徽章、討論區、即時同步請求數、矮視窗、依賴圖示

type ApiTask = { id: number; title: string };

/** 設定 REVIEW_SHOTS=<資料夾> 時輸出截圖（人工檢查用） */
const SHOTS = process.env.REVIEW_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openAs(browser: Browser, user: E2EUser, path: string, width = 1280, height = 800) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await loginViaUi(page, user, path);
  return page;
}

async function post<T>(page: Page, url: string, data: Record<string, unknown>): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as T;
}
const createTask = (page: Page, data: Record<string, unknown>) => post<ApiTask>(page, '/api/tasks', data);

const drawerOf = (page: Page) => page.locator('.task-drawer:not([data-leaving])');
const toasts = (page: Page) => page.getByRole('region', { name: '通知' });
const undoBtn = (page: Page) => page.locator('[data-undo-button="undo"]');
const checklistOf = (page: Page) => page.getByTestId('checklist');
const clRow = (page: Page, text: string) =>
  checklistOf(page).locator('[data-checklist-row]', { hasText: text });

test('M1 復原遇到永久性失敗（描述已被鎖定）：移除該筆並提示，之後可復原更早的動作', async ({ browser }) => {
  test.setTimeout(120_000);
  const P = `RVM1-${Date.now() % 1e6}`;
  const mgr = await openAs(browser, E2E_USERS.manager, '/tasks/list');
  const task = await createTask(mgr, { title: `${P} 任務`, description: '原本的描述' });
  const mem = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}&task=${task.id}`);
  const drawer = drawerOf(mem);
  await expect(drawer.getByText('建立於')).toBeVisible();

  // ① 新增待辦項目
  const add = checklistOf(mem).getByRole('textbox', { name: '新增待辦' });
  await add.fill('先做的事');
  await add.press('Enter');
  await expect(clRow(mem, '先做的事')).toHaveCount(1);
  await expect(undoBtn(mem)).toHaveAttribute('aria-label', '復原：新增待辦項目『先做的事』');
  // ② 改描述（Esc 離開輸入框即儲存）
  const desc = drawer.getByRole('textbox', { name: '描述' });
  await desc.fill('成員改過的描述');
  await desc.press('Escape');
  await expect(drawer.getByText('已儲存')).toBeVisible();
  await expect(undoBtn(mem)).toHaveAttribute('aria-label', `復原：修改『${P} 任務』的描述`);
  // ③ 管理者鎖定描述
  const lock = await mgr.request.patch(`/api/tasks/${task.id}`, { data: { descriptionLocked: true } });
  expect(lock.ok()).toBeTruthy();
  await expect(drawer.getByRole('note').getByText('描述已鎖定')).toBeVisible({ timeout: 10_000 });

  // 復原描述 → 403（永久性）：從復原紀錄移除並提示
  await mem.keyboard.press('Control+z');
  await expect(toasts(mem).getByText(`無法復原，已從復原紀錄移除：修改『${P} 任務』的描述`)).toBeVisible();
  await expect(undoBtn(mem)).toHaveAttribute('aria-label', '復原：新增待辦項目『先做的事』');
  // 再按一次：復原更早的動作（不會卡在同一個錯誤）
  await mem.keyboard.press('Control+z');
  await expect(clRow(mem, '先做的事')).toHaveCount(0);
  await expect(toasts(mem).getByText('已復原：新增待辦項目『先做的事』')).toBeVisible();

  await mgr.context().close();
  await mem.context().close();
});

test('M3 待辦清單拖曳中按 Esc 只取消拖曳，抽屜保持開啟（鍵盤與滑鼠）', async ({ page }) => {
  test.setTimeout(90_000);
  const P = `RVM3-${Date.now() % 1e6}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const task = await createTask(page, { title: `${P} 任務` });
  await post(page, `/api/tasks/${task.id}/checklist`, {
    items: [{ text: '甲' }, { text: '乙' }, { text: '丙' }],
  });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = drawerOf(page);
  await expect(clRow(page, '丙')).toHaveCount(1);
  const order = () => checklistOf(page).locator('[data-checklist-row] .cl-text').allTextContents();
  const before = await order();

  // 鍵盤拖曳：Space 拿起 → ↓ → Esc
  const handle = clRow(page, '甲').getByRole('button', { name: /拖曳排序：甲/ });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(drawer).toBeVisible();
  expect(await order()).toEqual(before);

  // 滑鼠拖曳中按 Esc
  await clRow(page, '乙').hover();
  const box = (await clRow(page, '乙')
    .getByRole('button', { name: /拖曳排序：乙/ })
    .boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(drawer).toBeVisible();
  expect(await order()).toEqual(before);

  // 沒在拖曳時 Esc 照常關閉抽屜
  await page.locator('.task-drawer-head').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('m2 快速連送兩則留言都送達；連續勾選兩項都登記復原', async ({ page }) => {
  test.setTimeout(90_000);
  const P = `RVM2-${Date.now() % 1e6}`;
  await loginViaUi(page, E2E_USERS.manager, '/tasks/list');
  const task = await createTask(page, { title: `${P} 任務` });
  await post(page, `/api/tasks/${task.id}/checklist`, { items: [{ text: '甲' }, { text: '乙' }] });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const disc = page.locator('section.disc');
  const input = disc.getByRole('combobox', { name: '討論區訊息' });
  await input.fill('第一則');
  await input.press('Enter');
  await input.fill('第二則');
  await input.press('Enter');
  await expect(disc.locator('.disc-body').filter({ hasText: /^第一則$/ })).toBeVisible();
  await expect(disc.locator('.disc-body').filter({ hasText: /^第二則$/ })).toBeVisible();
  await expect(disc.getByText('傳送中…')).toHaveCount(0, { timeout: 5_000 });

  // 連續勾選：兩筆都在復原堆疊
  const list = checklistOf(page);
  await list.getByRole('checkbox', { name: '標為完成：甲' }).click();
  await list.getByRole('checkbox', { name: '標為完成：乙' }).click();
  await expect(list.getByRole('checkbox', { name: '標為未完成：乙' })).toBeVisible();
  await page.locator('.task-drawer-head').click({ position: { x: 5, y: 5 } });
  await expect(undoBtn(page)).toHaveAttribute('aria-label', '復原：勾選待辦項目『乙』');
  await page.keyboard.press('Control+z');
  await expect(list.getByRole('checkbox', { name: '標為完成：乙' })).toBeVisible();
  await expect(undoBtn(page)).toHaveAttribute('aria-label', '復原：勾選待辦項目『甲』');
  await page.keyboard.press('Control+z');
  await expect(list.getByRole('checkbox', { name: '標為完成：甲' })).toBeVisible();

  // m4：1.5 秒內勾選又取消，不留下空的復原
  await list.getByRole('checkbox', { name: '標為完成：甲' }).click();
  await list.getByRole('checkbox', { name: '標為未完成：甲' }).click();
  await page.waitForTimeout(500);
  await expect(undoBtn(page)).toBeDisabled();
});

test('m3 toast 的「復原」不在堆疊頂端時：執行後從堆疊移除，之後 Ctrl+Z 不重複執行', async ({ page }) => {
  test.setTimeout(90_000);
  const P = `RVM3T-${Date.now() % 1e6}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const a = await createTask(page, { title: `${P} 主任務` });
  const b = await createTask(page, { title: `${P} 相關` });
  await post(page, `/api/tasks/${a.id}/relations`, { type: 'related', targetId: b.id });
  await post(page, `/api/tasks/${a.id}/checklist`, { text: '甲' });
  await page.goto(`/tasks/list?q=${P}&task=${a.id}`);
  const drawer = drawerOf(page);
  await drawer.getByRole('button', { name: `移除相關任務「${b.title}」` }).click();
  const relToast = toasts(page).locator('.ui-toast').filter({ hasText: '已移除相關任務' });
  await expect(toasts(page).getByText('已移除相關任務')).toBeVisible();
  // 另一個動作蓋在上面
  await checklistOf(page).getByRole('checkbox', { name: '標為完成：甲' }).click();
  await expect(undoBtn(page)).toHaveAttribute('aria-label', '復原：勾選待辦項目『甲』');
  // 按「已移除相關任務」toast 的復原
  await relToast.first().getByRole('button', { name: '復原' }).click();
  await expect(drawer.getByRole('button', { name: `移除相關任務「${b.title}」` })).toBeVisible();
  // 堆疊只剩勾選；Ctrl+Z 一次後堆疊清空（相關任務那筆不會再執行一次）
  await page.locator('.task-drawer-head').click({ position: { x: 5, y: 5 } });
  await expect(undoBtn(page)).toHaveAttribute('aria-label', '復原：勾選待辦項目『甲』');
  await page.keyboard.press('Control+z');
  await expect(checklistOf(page).getByRole('checkbox', { name: '標為完成：甲' })).toBeVisible();
  await expect(undoBtn(page)).toBeDisabled();
  const rels = (await (await page.request.get(`/api/tasks/${a.id}/relations`)).json()) as unknown[];
  expect(rels).toHaveLength(1);
});

test('m7 送一則留言的請求數（自己的 SSE 回音不再觸發第二輪重抓）', async ({ page }) => {
  test.setTimeout(90_000);
  const P = `RVM7-${Date.now() % 1e6}`;
  await loginViaUi(page, E2E_USERS.manager, '/tasks/list');
  const task = await createTask(page, { title: `${P} 任務` });
  await post(page, `/api/tasks/${task.id}/checklist`, { text: '甲' });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  await expect(checklistOf(page).getByText('甲')).toBeVisible();
  await page.waitForTimeout(1500);
  const requests: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && !/\/api\/(events|presence)/.test(u.pathname))
      requests.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  const input = page.locator('section.disc').getByRole('combobox', { name: '討論區訊息' });
  await input.fill('計數用的留言');
  await input.press('Enter');
  await expect(page.locator('section.disc .disc-body').filter({ hasText: '計數用的留言' })).toBeVisible();
  await page.waitForTimeout(2500);
  console.log(`[m7] 送一則留言的請求數：${requests.length}\n${requests.join('\n')}`);
  // 修正前為 13（mutation 失效整個 ['tasks'] ＋ SSE 回音再失效一次）
  expect(requests.length).toBeLessThanOrEqual(7);
  // 不重抓與留言無關的子資源
  expect(requests.filter((r) => /\/(checklist|relations|dependencies|history)/.test(r))).toEqual([]);
});

test('m8 矮視窗：討論區預設收合（內容區至少 200px），收合 / 展開狀態會記住', async ({ browser }) => {
  test.setTimeout(90_000);
  const P = `RVM8-${Date.now() % 1e6}`;
  const page = await openAs(browser, E2E_USERS.manager, '/tasks/list');
  const task = await createTask(page, { title: `${P} 任務`, description: '描述' });
  await post(page, `/api/tasks/${task.id}/comments`, { body: '一則討論' });
  // 窄視窗的導覽列為收合選單：以一般寬度登入後再縮成 667×375
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = drawerOf(page);
  const disc = page.locator('section.disc');
  await expect(disc).toHaveAttribute('data-mode', 'collapsed');
  const body = drawer.locator('.task-drawer-body');
  expect((await body.boundingBox())!.height).toBeGreaterThanOrEqual(200);
  await shot(page, '667x375-drawer-collapsed');

  // 展開 → 重新整理仍展開（記住使用者的選擇）
  await disc.getByRole('button', { name: /^討論/ }).click();
  await expect(disc).toHaveAttribute('data-mode', 'normal');
  await shot(page, '667x375-drawer-expanded');
  await page.reload();
  await expect(page.locator('section.disc')).toHaveAttribute('data-mode', 'normal');
  // 收合 → 換到高視窗也維持收合
  await page.locator('section.disc').getByRole('button', { name: /^討論/ }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.locator('section.disc')).toHaveAttribute('data-mode', 'collapsed');
  await page.locator('section.disc').getByRole('button', { name: /^討論/ }).click();

  // 1280×500：討論區降高，內容區保有空間
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.waitForTimeout(300);
  const h500 = (await drawer.locator('.task-drawer-body').boundingBox())!.height;
  expect(h500).toBeGreaterThanOrEqual(150);
  await shot(page, '1280x500-drawer');
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 500 });
    await page.waitForTimeout(300);
    expect((await drawer.locator('.task-drawer-body').boundingBox())!.height).toBeGreaterThanOrEqual(150);
    await shot(page, `${width}x500-drawer`);
  }
  await page.context().close();
});

test('M4 / m11 清單標題：五種徽章齊全時標題保底 8 字、徽章不被切；等待中改用沙漏且可聚焦', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const P = `RVM4-${Date.now() % 1e6}`;
  const mgr = await openAs(browser, E2E_USERS.manager, '/tasks/list');
  const title = `${P} 報表模組整合測試與部署前檢查`;
  const main = await createTask(mgr, { title, description: '說明', descriptionLocked: true });
  const blocker = await createTask(mgr, { title: `${P} 前置` });
  const related = await createTask(mgr, { title: `${P} 相關` });
  await post(mgr, `/api/tasks/${main.id}/dependencies`, { direction: 'blocked_by', targetId: blocker.id });
  await post(mgr, `/api/tasks/${main.id}/relations`, { type: 'related', targetId: related.id });
  await post(mgr, `/api/tasks/${main.id}/checklist`, { items: [{ text: '甲' }, { text: '乙' }] });
  await post(mgr, `/api/tasks/${main.id}/comments`, { body: '請看一下 @member' });
  const mem = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${encodeURIComponent(P)}`);
  const row = mem.locator(`.tl-row--task[data-task-id="${main.id}"]`);
  await expect(row.getByTestId('dep-lock')).toBeVisible();

  for (const width of [1280, 1024, 768]) {
    await mem.setViewportSize({ width, height: 800 });
    await mem.waitForTimeout(400);
    const m = await row.locator('.tl-cell--title').evaluate((cell) => {
      const r = cell.getBoundingClientRect();
      const text = cell.querySelector('.tl-title-text') ?? cell.querySelector('.tl-field');
      const tr = text!.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(text!).fontSize);
      const box = cell.querySelector('.tl-tbadges')!;
      const top = (box.querySelector('.tl-tbadge:not(:empty)') as HTMLElement | null)?.offsetTop ?? 0;
      const visible = [...box.querySelectorAll<HTMLElement>('.tl-tbadge')].filter(
        (k) => k.offsetWidth > 0 && k.offsetTop <= top + 2,
      );
      const more = cell.querySelector('.tl-tbadge-more');
      const rights = [...visible, ...(more ? [more] : [])].map((e) => e.getBoundingClientRect().right);
      return {
        textWidth: tr.width,
        em,
        cellRight: r.right,
        maxRight: Math.max(...rights),
        boxRight: box.getBoundingClientRect().right,
        visible: visible.map((k) => k.dataset.badge),
        more: more?.getAttribute('aria-label') ?? null,
      };
    });
    console.log(`[M4] ${width}: ${JSON.stringify(m)}`);
    // 1280 / 1024：標題保底 8 字；768（列動作鈕常駐）保底 4 字
    expect(m.textWidth).toBeGreaterThanOrEqual((width >= 1024 ? 8 : 4) * m.em - 1);
    expect(m.maxRight).toBeLessThanOrEqual(m.cellRight + 0.5);
    expect(m.boxRight).toBeLessThanOrEqual(m.cellRight + 0.5);
    if (width >= 1024) {
      // 優先保留未讀留言與等待中；其餘收成「+N」
      expect(m.visible.slice(0, 2)).toEqual(['unread', 'waiting']);
      if (m.visible.length < 5) expect(m.more).toMatch(/^另有 \d+ 項：/);
    } else {
      // 窄寬：全部收成一顆「+5」（有未讀時強調）
      expect(m.visible).toEqual([]);
      expect(m.more).toMatch(/^另有 5 項：/);
      await expect(row.getByTestId('title-badges-more')).toHaveAttribute('data-unread', 'true');
    }
    await shot(mem, `list-title-badges-${width}`);
  }

  // m11：看板卡片的等待中為沙漏（不是鎖頭）、可用 Tab 聚焦並顯示說明
  await mem.setViewportSize({ width: 1280, height: 800 });
  await mem.goto(`/tasks/kanban?q=${encodeURIComponent(P)}`);
  const card = mem.locator('.kanban-card', { hasText: title });
  const hourglass = card.getByTestId('dep-lock').getByRole('img');
  await expect(hourglass).toHaveAttribute('aria-label', /^等待中：/);
  await expect(card.getByTestId('dep-lock').locator('svg path')).toHaveCount(1);
  await hourglass.focus();
  await expect(mem.getByRole('tooltip')).toBeVisible();
  await expect(hourglass.locator('..')).toHaveAttribute('aria-describedby', /.+/);
  await shot(mem, 'kanban-hourglass-focus-1280');
  for (const width of [1024, 768]) {
    await mem.setViewportSize({ width, height: 800 });
    await mem.waitForTimeout(300);
    await shot(mem, `kanban-hourglass-${width}`);
  }

  await mgr.context().close();
  await mem.context().close();
});

test('刪除抽屜中的任務後不出現 404（子資源不重抓）', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const P = `RV404-${Date.now() % 1e6}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const task = await createTask(page, { title: `${P} 要刪的` });
  await post(page, `/api/tasks/${task.id}/checklist`, { text: '甲' });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = drawerOf(page);
  await expect(checklistOf(page).getByText('甲')).toBeVisible();
  await drawer.getByRole('button', { name: '更多動作' }).click();
  await page.getByRole('menuitem', { name: '刪除任務' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '刪除', exact: true }).click();
  await expect(page.locator('.task-drawer')).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});
