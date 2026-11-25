import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// feat/gantt-overview：總覽（目前無任務者排前且明顯標示）→ Gantt（刻度切換、今日線、未排程、排入日期、拖曳改日期、開啟詳情）
test.describe.configure({ mode: 'serial' });

const pad = (n: number) => String(n).padStart(2, '0');
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Task = { id: number; title: string; startDate: string | null; dueDate: string | null };

async function api<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const req: APIRequestContext = page.request;
  const origin = new URL(page.url()).origin;
  const res = await req.fetch(`${origin}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

const suffix = Date.now().toString(36);
const SCHEDULED = `甘特排程 ${suffix}`;
const UNSCHEDULED = `未排程 ${suffix}`;

test('總覽：目前無任務的成員排前並標示；Gantt：刻度、今日線、未排程、拖曳改日期', async ({ page }) => {
  test.setTimeout(90_000);
  await loginViaUi(page, E2E_USERS.admin, '/');
  // 登入前的 401（/api/auth/me 探測）屬預期，之後不得再有 console error
  const errors = collectErrors(page);

  const users = await api<{ id: number; username: string }[]>(page, 'GET', '/api/users');
  const admin = users.find((u) => u.username === E2E_USERS.admin.username)!;
  const member = users.find((u) => u.username === E2E_USERS.member.username)!;

  const scheduled = await api<Task>(page, 'POST', '/api/tasks', {
    title: SCHEDULED,
    statusId: 2, // 進行中
    assigneeId: admin.id,
    startDate: day(-2),
    dueDate: day(5),
    progress: 40,
    estimateHours: 6,
  });
  const unscheduled = await api<Task>(page, 'POST', '/api/tasks', { title: UNSCHEDULED });

  /* ── 總覽 ── */
  await page.goto('/');
  const memberCard = page.getByTestId(`member-card-${member.id}`);
  const adminCard = page.getByTestId(`member-card-${admin.id}`);
  await expect(memberCard).toBeVisible();
  await expect(memberCard.getByText('目前無任務', { exact: true })).toBeVisible();
  await expect(memberCard.getByText('沒有進行中的任務')).toBeVisible();
  await expect(adminCard.getByRole('button', { name: SCHEDULED })).toBeVisible();
  await expect(adminCard.getByText('目前無任務', { exact: true })).toHaveCount(0);
  // 「目前無任務」區段在「進行中」區段之前，且成員卡在前者內
  const idleSection = page.locator('#overview-idle');
  await expect(idleSection.getByTestId(`member-card-${member.id}`)).toBeVisible();
  const cards = page.locator('[data-testid^="member-card-"]');
  const order = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(order.indexOf(`member-card-${member.id}`)).toBeLessThan(order.indexOf(`member-card-${admin.id}`));
  await expect(page.getByTestId('stat-idle')).toContainText('目前無任務');
  // 精簡 Gantt 顯示進行中任務的長條（唯讀，無把手）
  await expect(page.getByTestId(`gantt-bar-${scheduled.id}`)).toBeVisible();
  await expect(page.getByTestId(`gantt-handle-end-${scheduled.id}`)).toHaveCount(0);
  // 卡片上的任務可開啟詳情
  await adminCard.getByRole('button', { name: SCHEDULED }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${scheduled.id}`));

  /* ── Gantt ── */
  await page.goto('/tasks/gantt?scale=week');
  const bar = page.getByTestId(`gantt-bar-${scheduled.id}`);
  await expect(bar).toBeVisible();
  // 週刻度 8 天 = 128px：標題在條內
  await expect(bar.locator('.gantt-bar-label--in')).toContainText(SCHEDULED);
  // 今天膠囊與刻度文字並排（不蓋住刻度）、今日線一條
  await expect(page.locator('.gantt-head-cell.is-today .gantt-today-chip')).toHaveText('今天');
  await expect(page.locator('.gantt-head-cell.is-today .gantt-head-label')).toBeVisible();
  await expect(page.locator('.gantt-today-line')).toHaveCount(1);
  // 左欄：無「更新」欄，改為起訖日期區間
  await expect(page.locator('.gantt-head-corner')).toHaveText(/任務\s*起訖/);
  const row = page.locator(`[data-row-key="t${scheduled.id}"]`);
  await expect(row.locator('.gantt-task-dates')).toBeVisible();
  await expect(row.locator('.ui-updated-at')).toHaveCount(0);
  // 時間軸填滿容器寬
  const fill = await page.locator('.gantt-scroll').evaluate((el) => el.scrollWidth >= el.clientWidth);
  expect(fill).toBeTruthy();

  // 刻度切換
  const scaleGroup = page.getByRole('group', { name: '時間刻度' });
  for (const [label, scale] of [
    ['月', 'month'],
    ['週', 'week'],
    ['日', 'day'],
  ] as const) {
    await scaleGroup.getByRole('button', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`scale=${scale}`));
    await expect(scaleGroup.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar).toBeVisible();
  }
  // 手動切換的刻度記在 localStorage：不帶 scale 參數重新進頁仍為日刻度
  await page.goto('/tasks/gantt');
  await expect(scaleGroup.getByRole('button', { name: '日' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar).toBeVisible();

  // 未排程區：沒有日期的任務不會消失，可排入日期（開始日與到期日預填今天）
  const unscheduledRow = page.getByTestId(`unscheduled-${unscheduled.id}`);
  await expect(page.getByRole('button', { name: /^未排程\s*\d+$/ })).toBeVisible();
  await expect(unscheduledRow).toContainText(UNSCHEDULED);
  await unscheduledRow.getByRole('button', { name: '排入日期' }).click();
  const dialog = page.getByRole('dialog', { name: `設定「${UNSCHEDULED}」的日期` });
  await expect(dialog.getByLabel('開始日')).toHaveValue(day(0));
  await expect(dialog.getByLabel('到期日')).toHaveValue(day(0));
  await dialog.getByLabel('開始日').fill(day(3));
  await dialog.getByLabel('到期日').fill(day(1));
  await expect(dialog.getByText('到期日不可早於開始日')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '儲存' })).toBeDisabled();
  await dialog.getByLabel('到期日').fill(day(4));
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`gantt-bar-${unscheduled.id}`)).toBeVisible();
  await expect(unscheduledRow).toHaveCount(0);

  // 日刻度下拖曳長條本體 +2 天（每日 32px）
  await bar.scrollIntoViewIfNeeded();
  const box = (await bar.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const patched = page.waitForResponse(
    (r) => r.url().endsWith(`/api/tasks/${scheduled.id}`) && r.request().method() === 'PATCH',
  );
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y, { steps: 4 });
  await page.mouse.move(x + 64, y, { steps: 6 });
  await expect(page.getByRole('status').filter({ hasText: '→' })).toContainText('（8 天）');
  await page.mouse.up();
  expect((await patched).status()).toBe(200);
  const after = await api<Task>(page, 'GET', `/api/tasks/${scheduled.id}`);
  expect(after.startDate).toBe(day(0));
  expect(after.dueDate).toBe(day(7));

  // 拖右把手：只改到期日
  const box2 = (await page.getByTestId(`gantt-handle-end-${scheduled.id}`).boundingBox())!;
  const patched2 = page.waitForResponse(
    (r) => r.url().endsWith(`/api/tasks/${scheduled.id}`) && r.request().method() === 'PATCH',
  );
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 3 + 32, box2.y + box2.height / 2, { steps: 6 });
  await page.mouse.up();
  await patched2;
  const after2 = await api<Task>(page, 'GET', `/api/tasks/${scheduled.id}`);
  expect(after2.startDate).toBe(day(0));
  expect(after2.dueDate).toBe(day(8));

  // 分組切換
  await page.getByRole('button', { name: '分組' }).click();
  await page.getByRole('option', { name: '分組：專案' }).click();
  await expect(page).toHaveURL(/group=project/);
  await expect(page.getByRole('treeitem', { name: /預設專案/ })).toBeVisible();

  // 點擊長條開啟任務詳情
  await page.getByTestId(`gantt-bar-${unscheduled.id}`).click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${unscheduled.id}`));

  expect(errors).toEqual([]);
});

test('總覽：近三週（迷你直條、Tooltip、展開詳情、有估時才顯示工時）', async ({ page }) => {
  test.setTimeout(60_000);
  await loginViaUi(page, E2E_USERS.admin, '/');
  const errors = collectErrors(page);

  const users = await api<{ id: number; username: string }[]>(page, 'GET', '/api/users');
  const admin = users.find((u) => u.username === E2E_USERS.admin.username)!;
  const DONE_EST = `近三週有估時 ${suffix}`;
  const DONE_NO_EST = `近三週沒估時 ${suffix}`;
  const done1 = await api<Task>(page, 'POST', '/api/tasks', {
    title: DONE_EST,
    statusId: 4, // 完成
    assigneeId: admin.id,
    estimateHours: 3,
  });
  await api<Task>(page, 'POST', '/api/tasks', { title: DONE_NO_EST, statusId: 4, assigneeId: admin.id });

  const activity = await api<{
    weeks: { current: boolean }[];
    members: { userId: number; weeks: { completed: number; hoursKnown: number }[] }[];
  }>(page, 'GET', '/api/overview/activity');
  expect(activity.weeks.map((w) => w.current)).toEqual([false, false, true]);
  const mine = activity.members.find((m) => m.userId === admin.id)!.weeks[2]!;
  expect(mine.completed).toBeGreaterThanOrEqual(2);
  expect(mine.hoursKnown).toBeGreaterThanOrEqual(1);

  await page.goto('/');
  // 全隊合計：中性呈現
  const team = page.getByTestId('team-weeks');
  await expect(team).toContainText('近三週團隊進展');
  await expect(team).toContainText('本週');

  const adminCard = page.getByTestId(`member-card-${admin.id}`);
  const toggle = adminCard.getByRole('button', { name: /^近三週：/ });
  await expect(toggle).toBeVisible();
  await expect(adminCard.locator('.ov-bar')).toHaveCount(3);
  await expect(toggle).toContainText(/完成 \d+・處理 \d+/);
  // 鍵盤 focus 顯示 Tooltip（緩和語氣）
  await toggle.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tooltip')).toContainText(/本週：完成 \d+ 件、處理 \d+ 件/);

  // 展開詳情（鍵盤可操作）：預設本週
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = adminCard.getByRole('region', { name: /近三週的任務/ });
  await expect(panel.getByRole('button', { name: '本週' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: DONE_EST })).toBeVisible();
  await expect(panel.getByRole('button', { name: DONE_NO_EST })).toBeVisible();
  await expect(panel).toContainText(/預估工時約 [\d.]+ 小時（\d+ 件有填估時）/);
  // 前週沒有紀錄：說「這週沒有紀錄」，且不顯示工時
  await panel.getByRole('button', { name: '前週' }).click();
  await expect(panel).toContainText('這週沒有紀錄');
  await expect(panel).not.toContainText('預估工時');
  // 不出現排名 / 落後字眼
  await expect(page.locator('.ov-page')).not.toContainText(/排名|落後|最少|沒做事/);
  // 任務可開啟詳情
  await panel.getByRole('button', { name: '本週' }).click();
  await panel.getByRole('button', { name: DONE_EST }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${done1.id}`));

  expect(errors).toEqual([]);
});
