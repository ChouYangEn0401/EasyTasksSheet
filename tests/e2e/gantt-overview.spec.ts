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
  await page.goto('/tasks/gantt');
  const bar = page.getByTestId(`gantt-bar-${scheduled.id}`);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('40%');
  await expect(page.locator('.gantt-today-pill')).toHaveText('今天');
  await expect(page.locator('.gantt-today-line')).toHaveCount(1);

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

  // 未排程區：沒有日期的任務不會消失，可排入日期
  const unscheduledRow = page.getByTestId(`unscheduled-${unscheduled.id}`);
  await expect(page.getByRole('button', { name: /未排程（\d+）/ })).toBeVisible();
  await expect(unscheduledRow).toContainText(UNSCHEDULED);
  await unscheduledRow.getByRole('button', { name: '排入日期' }).click();
  const dialog = page.getByRole('dialog', { name: `設定「${UNSCHEDULED}」的日期` });
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
