import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi, type E2EUser } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// feat/task-discussion：任務抽屜的討論區（討論串、@提及、未讀）與描述鎖定。docs/design/task-discussion.md
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; commentCount: number; unreadComments: number };
type ApiComment = { id: number };

/** 設定 DISCUSSION_SHOTS=<資料夾> 時輸出版面截圖（人工檢查用） */
const SHOTS = process.env.DISCUSSION_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// 截圖時顯示捲軸（headless 預設隱藏捲軸，看不到捲軸設計）
if (SHOTS) test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const SYNC = { timeout: 5_000 };

async function openAs(browser: Browser, user: E2EUser, path: string, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await loginViaUi(page, user, path);
  return page;
}

async function createTask(page: Page, data: Record<string, unknown>): Promise<ApiTask> {
  const res = await page.request.post('/api/tasks', { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as ApiTask;
}

async function comment(page: Page, taskId: number, data: Record<string, unknown>): Promise<ApiComment> {
  const res = await page.request.post(`/api/tasks/${taskId}/comments`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as ApiComment;
}

const drawerOf = (page: Page) => page.locator('.task-drawer');
const discOf = (page: Page) => page.locator('section.disc');
/** 討論區中內容含 text 的訊息 */
const msgOf = (page: Page, text: string | RegExp) =>
  discOf(page).locator('.disc-body').filter({ hasText: text });
const rowOf = (page: Page, title: string) => page.locator('.tl-row--task', { hasText: title });

test('鎖定描述 → 成員被擋並看到提示 → 討論串、即時同步、已解決、@提及未讀', async ({ browser }) => {
  test.setTimeout(120_000);
  const P = `DISC-${Date.now()}`;
  const mgr = await openAs(browser, E2E_USERS.manager, `/tasks/list?q=${P}`);
  const task = await createTask(mgr, {
    title: `${P} 報表模組測試`,
    description: '報表生成模組需要再測一次。\n確認 (1) feature (2) pipeline 可用。',
  });

  // 管理者在詳情鎖定描述
  await mgr.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const mDrawer = drawerOf(mgr);
  await expect(mDrawer.getByText('建立於')).toBeVisible();
  await expect(discOf(mgr).getByText('還沒有討論')).toBeVisible();
  await shot(mgr, '1280-empty');
  await mDrawer.getByRole('button', { name: '鎖定（避免誤改）' }).click();
  await expect(mDrawer.getByRole('note').getByText('描述已鎖定')).toBeVisible();
  await expect(mDrawer.getByRole('button', { name: '解除鎖定' })).toHaveAttribute('aria-pressed', 'true');
  // 有權限者仍可編輯描述
  await expect(mDrawer.getByRole('textbox', { name: '描述' })).not.toHaveAttribute('readonly');

  // 成員：描述唯讀、看到提示條；API 直接改也被擋
  const mem = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}&task=${task.id}`);
  const uDrawer = drawerOf(mem);
  const banner = uDrawer.getByRole('note');
  await expect(banner).toContainText('描述已鎖定');
  await expect(banner).toContainText('有補充或筆記，歡迎寫在下方討論區');
  await expect(uDrawer.getByRole('textbox', { name: '描述' })).toHaveAttribute('readonly', '');
  await expect(uDrawer.getByRole('button', { name: '鎖定（避免誤改）' })).toHaveCount(0);
  await banner.scrollIntoViewIfNeeded();
  await shot(mem, '1280-lock-banner');
  const denied = await mem.request.patch(`/api/tasks/${task.id}`, { data: { description: '亂改' } });
  expect(denied.status()).toBe(403);
  expect(((await denied.json()) as { error: { message: string } }).error.message).toBe(
    '描述已由管理者鎖定，請把補充寫在討論區',
  );
  // 其他欄位不受影響
  expect((await mem.request.patch(`/api/tasks/${task.id}`, { data: { progress: 20 } })).ok()).toBeTruthy();

  // 成員在討論區發表（Enter 送出）
  const uInput = discOf(mem).getByRole('combobox', { name: '討論區訊息' });
  await uInput.fill('請問 pipeline 要跑哪個分支？');
  await uInput.press('Enter');
  await expect(msgOf(mem, '請問 pipeline 要跑哪個分支？')).toBeVisible();
  await expect(uInput).toHaveValue('');

  // 管理者即時看到並回覆，形成討論串；@ 選單提及成員
  const mDisc = discOf(mgr);
  await expect(msgOf(mgr, '請問 pipeline 要跑哪個分支？')).toBeVisible(SYNC);
  // 成員先關閉抽屜（之後的提及才會顯示為未讀）
  await uDrawer.getByRole('button', { name: '關閉任務詳情' }).click();
  await expect(uDrawer).toHaveCount(0);

  // 回覆 / 標記已解決在滑鼠移入訊息時出現
  await msgOf(mgr, '請問 pipeline 要跑哪個分支？').hover();
  await mDisc.getByRole('button', { name: '回覆', exact: true }).first().click();
  await expect(mDisc.getByText('回覆 @一般成員 的訊息')).toBeVisible();
  const mInput = mDisc.getByRole('combobox', { name: '討論區訊息' });
  await mInput.pressSequentially('@mem');
  const option = mDisc.getByRole('option', { name: /一般成員/ });
  await expect(option).toBeVisible();
  await mInput.press('Enter');
  await expect(mInput).toHaveValue('@member ');
  await mInput.pressSequentially('跑 main 就好');
  await mInput.press('Enter');
  await expect(msgOf(mgr, '跑 main 就好')).toBeVisible();
  await expect(mDisc.locator('.disc-replies .disc-mention').first()).toHaveText('@一般成員');
  await shot(mgr, '1280-thread-expanded');

  // @提及：成員的清單徽章出現未讀
  const badge = rowOf(mem, task.title).locator('.task-badge--comments');
  await expect(badge).toBeVisible(SYNC);
  await expect(badge).toHaveAttribute('data-unread', 'true', SYNC);
  await expect(rowOf(mem, task.title).locator('.task-badge--lock')).toBeVisible();
  await shot(mem, '1280-list-badges');

  // 開啟後：串預設收合（未讀在回覆中會自動展開）、看得到未讀分隔線；已讀後徽章不再強調
  await mem.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const uDisc = discOf(mem);
  await expect(msgOf(mem, '跑 main 就好')).toBeVisible();
  await expect(uDisc.getByRole('separator', { name: '以下為未讀訊息' })).toBeVisible();
  await expect(badge).not.toHaveAttribute('data-unread', 'true', SYNC);
  // 收合 / 展開回覆
  await uDisc.getByRole('button', { name: '收合回覆' }).click();
  await expect(msgOf(mem, '跑 main 就好')).toHaveCount(0);
  await uDisc.getByRole('button', { name: '1 則回覆' }).click();
  await expect(msgOf(mem, '跑 main 就好')).toBeVisible();

  // 管理者標記已解決 → 雙方看到「已解決」並淡化收合
  await msgOf(mgr, '請問 pipeline 要跑哪個分支？').hover();
  await mDisc.getByRole('button', { name: '標記為已解決' }).click();
  await expect(mDisc.locator('.disc-resolved-tag')).toBeVisible();
  await expect(uDisc.locator('.disc-resolved-tag')).toBeVisible(SYNC);
  await expect(uDisc.locator('.disc-thread[data-resolved="true"]')).toHaveCount(1);
  await uDisc.getByRole('button', { name: '未解決', exact: true }).click();
  await expect(uDisc.getByText('目前沒有未解決的討論。')).toBeVisible();
  await uDisc.getByRole('button', { name: '全部', exact: true }).click();

  // 看板卡片也有徽章
  await mem.goto(`/tasks/kanban?q=${P}`);
  const card = mem.locator('.kanban-card', { hasText: task.title });
  await expect(card.locator('.task-badge--comments')).toContainText('2');
  await expect(card.locator('.task-badge--lock')).toBeVisible();
  await shot(mem, '1280-kanban-badges');

  // 一般成員不能切換鎖（API）
  const toggle = await mem.request.patch(`/api/tasks/${task.id}`, { data: { descriptionLocked: false } });
  expect(toggle.status()).toBe(403);

  await mgr.context().close();
  await mem.context().close();
});

test('大量訊息：討論區高度固定、不撐開抽屜，可載入更早的討論；聚焦模式與 Esc 還原', async ({ browser }) => {
  test.setTimeout(120_000);
  const P = `DISC-BULK-${Date.now()}`;
  const admin = await openAs(browser, E2E_USERS.admin, `/tasks/list?q=${P}`);
  const peer = await openAs(browser, E2E_USERS.peer, `/tasks/list?q=${P}`);
  const task = await createTask(admin, { title: `${P} 很多討論` });
  // 速率限制為每人每分鐘 30 則：兩位成員各建 30 則
  const roots: ApiComment[] = [];
  for (let i = 0; i < 30; i++) roots.push(await comment(admin, task.id, { body: `管理員的討論 ${i + 1}` }));
  for (let i = 0; i < 30; i++)
    await comment(peer, task.id, {
      body:
        i === 29
          ? `很長的訊息\n${Array.from({ length: 12 }, (_, k) => `第 ${k + 1} 行：補充說明`).join('\n')}`
          : `晴恩的回覆 ${i + 1}`,
      ...(i < 12 ? { parentId: roots[29]!.id } : {}),
    });
  const tooMany = await admin.request.post(`/api/tasks/${task.id}/comments`, { data: { body: '第 31 則' } });
  expect(tooMany.status()).toBe(429);

  // 先標記已讀：沒有未讀時進入會捲到最新、回覆全部收合（未讀分隔線在第一個測試驗證）
  expect((await admin.request.post(`/api/tasks/${task.id}/comments/read`, { data: {} })).ok()).toBeTruthy();
  await admin.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const drawer = drawerOf(admin);
  const disc = discOf(admin);
  await expect(disc.getByText('展開全文')).toBeVisible();
  const scroll = disc.locator('.disc-scroll');

  // 高度固定：clamp(240px, 42vh, 460px)；800 高 → 336px。抽屜本身不捲動、不超出視窗
  const discBox = (await disc.boundingBox())!;
  expect(Math.round(discBox.height)).toBe(336);
  const drawerBox = (await drawer.boundingBox())!;
  expect(drawerBox.y + drawerBox.height).toBeLessThanOrEqual(800 + 1);
  const overflow = await scroll.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflow).toBe(true);
  // 輸入框固定在底部（不在捲動區內）
  await expect(disc.locator('.disc-scroll .disc-composer')).toHaveCount(0);
  await expect(disc.getByRole('combobox', { name: '討論區訊息' })).toBeInViewport();

  // 進入時捲到最新（貼底）
  const atBottom = await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  expect(atBottom).toBe(true);
  // 串內回覆預設收合
  await expect(disc.getByRole('button', { name: /^12 則回覆/ })).toBeVisible();
  await disc.getByRole('button', { name: /^12 則回覆/ }).click();
  await expect(disc.getByRole('button', { name: /顯示更早的回覆（7）/ })).toBeVisible();
  await disc.getByRole('button', { name: /顯示更早的回覆/ }).click();
  await expect(disc.getByRole('button', { name: /顯示更早的回覆（2）/ })).toBeVisible();
  await disc.getByRole('button', { name: /顯示更早的回覆/ }).click();
  await expect(msgOf(admin, /^晴恩的回覆 1$/)).toBeVisible();
  await expect(disc.getByRole('button', { name: /顯示更早的回覆/ })).toHaveCount(0);

  // 頂端有「載入更早的討論」（60 則 → 超過 20 串）
  await scroll.evaluate((el) => (el.scrollTop = 0));
  const older = disc.getByRole('button', { name: '載入更早的討論' });
  await expect(older).toBeVisible();
  await expect(msgOf(admin, /^管理員的討論 1$/)).toHaveCount(0);
  await older.click();
  // 依最新活動排序：第二頁為較早的 20 串
  await expect(msgOf(admin, /^管理員的討論 9$/)).toBeAttached();
  await expect(msgOf(admin, /^管理員的討論 8$/)).toHaveCount(0);

  // 不在底部時他人的新訊息 → 顯示「有新訊息」，不強制捲動
  await scroll.evaluate((el) => (el.scrollTop = 0));
  // 兩位成員都已達速率上限 → 由第三人（member）發新訊息
  const member = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}`);
  await comment(member, task.id, { body: '成員的新訊息' });
  const jump = disc.getByRole('button', { name: '有新訊息' });
  await expect(jump).toBeVisible({ timeout: 10_000 });
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThan(50);
  // 捲軸 hover 狀態截圖
  await scroll.hover();
  await shot(admin, '1280-scrollbar-hover');
  await jump.click();
  await expect(msgOf(admin, '成員的新訊息')).toBeInViewport();

  // 聚焦模式：討論區佔滿抽屜，內容區隱藏；Esc 還原
  await disc.getByRole('button', { name: '展開討論區' }).click();
  await expect(drawer.locator('.task-drawer-body')).toBeHidden();
  const focusBox = (await disc.boundingBox())!;
  expect(focusBox.height).toBeGreaterThan(600);
  await shot(admin, '1280-focus-mode');
  await scroll.click({ position: { x: 5, y: 5 } });
  await admin.keyboard.press('Escape');
  await expect(drawer.locator('.task-drawer-body')).toBeVisible();
  await expect(drawer).toBeVisible();

  // 768 寬：版面仍可用
  await admin.setViewportSize({ width: 768, height: 800 });
  await expect(disc.getByRole('combobox', { name: '討論區訊息' })).toBeInViewport();
  await shot(admin, '768-bulk');
  await disc.getByRole('button', { name: '展開討論區' }).click();
  await shot(admin, '768-focus-mode');
  await disc.getByRole('button', { name: '還原討論區大小' }).click();

  await admin.context().close();
  await peer.context().close();
  await member.context().close();
});

// 斷言一律執行；設定 DISCUSSION_SHOTS 時才額外輸出截圖
test('768 寬：空狀態、鎖定提示與清單徽章', async ({ browser }) => {
  const P = `DISC-768-${Date.now()}`;
  const mgr = await openAs(browser, E2E_USERS.manager, `/tasks/list?q=${P}`, 768);
  const t1 = await createTask(mgr, { title: `${P} 有討論`, description: '說明', descriptionLocked: true });
  await createTask(mgr, { title: `${P} 沒有討論` });
  await comment(mgr, t1.id, { body: '第一則：請大家把測試結果補在這裡 https://example.com/report' });
  const mem = await openAs(browser, E2E_USERS.member, `/tasks/list?q=${P}`, 768);
  // 768 寬時標題欄放不下徽章，會收成「+N」（aria-label 列出被收合的項目，含留言徽章）
  const moreChip = rowOf(mem, `${P} 有討論`).locator('.tl-tbadge-more');
  const badge = rowOf(mem, `${P} 有討論`).locator('.task-badge--comments');
  await expect(async () => {
    const shown = await badge.isVisible();
    const collapsed =
      (await moreChip.count()) > 0 && /討論/.test((await moreChip.getAttribute('aria-label')) ?? '');
    expect(shown || collapsed).toBe(true);
  }).toPass();
  await shot(mem, '768-list-badges');
  await mem.goto(`/tasks/list?q=${P}&task=${t1.id}`);
  await expect(drawerOf(mem).getByRole('note')).toBeVisible();
  await drawerOf(mem).getByRole('note').scrollIntoViewIfNeeded();
  await shot(mem, '768-lock-banner');
  const t2 = await createTask(mgr, { title: `${P} 空的` });
  await mem.goto(`/tasks/list?q=${P}&task=${t2.id}`);
  await expect(discOf(mem).getByText('還沒有討論')).toBeVisible();
  await shot(mem, '768-empty');
  await mgr.context().close();
  await mem.context().close();
});
