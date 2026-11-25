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

// 甘特圖：未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）。
// 指標拖曳（預覽長條 + 氣泡）、重整保留、復原 / 重做、依負責人分組改指派、預估工時決定天數、
// 拖回未排程區 / Esc 取消、鍵盤拖曳、沒有 tasks.edit 無把手。截圖於設定 GANTT_DRAG_SHOTS 時輸出。
test.describe.configure({ mode: 'serial' });

type ApiTask = {
  id: number;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  assigneeId: number | null;
};

const stamp = Date.now().toString(36);
const T = {
  s1: `排程拖曳-既有A-${stamp}`,
  s2: `排程拖曳-既有B-${stamp}`,
  u1: `排程拖曳-無工時-${stamp}`,
  u2: `排程拖曳-有工時-${stamp}`,
  u3: `排程拖曳-改指派-${stamp}`,
  u4: `排程拖曳-鍵盤-${stamp}`,
  u5: `排程拖曳-取消-${stamp}`,
};
const SHOTS = process.env.GANTT_DRAG_SHOTS;
const json = { 'Content-Type': 'application/json' };
const DW = 32; // 日刻度每日寬
const ids: Record<keyof typeof T, number> = { s1: 0, s2: 0, u1: 0, u2: 0, u3: 0, u4: 0, u5: 0 };
let managerId = 0;
let memberId = 0;

const pad = (n: number) => String(n).padStart(2, '0');
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function md(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function getTask(req: APIRequestContext, id: number): Promise<ApiTask> {
  return (await (await req.get(`/api/tasks/${id}`)).json()) as ApiTask;
}

const GANTT_URL = () => `/tasks/gantt?q=${stamp}&scale=day&group=assignee`;
const unscheduledRow = (page: Page, id: number) => page.getByTestId(`unscheduled-${id}`);
const handleOf = (page: Page, id: number) => unscheduledRow(page, id).locator('.gantt-sched-handle');
const bubble = (page: Page) => page.getByTestId('gantt-sched-bubble');
const live = (page: Page) => page.getByTestId('gantt-sched-live');

/** 時間軸上「今天 + offset」那一天的中心 x（以既有長條 S1 的起點 = 今天為基準） */
async function dayX(page: Page, offset: number): Promise<number> {
  const box = (await page.getByTestId(`gantt-bar-${ids.s1}`).boundingBox())!;
  return box.x + offset * DW + DW / 2;
}
async function rowY(page: Page, rowKey: string): Promise<number> {
  const box = (await page.locator(`[data-row-key="${rowKey}"]`).boundingBox())!;
  return box.y + box.height / 2;
}

/** 以 page.mouse 分段移動拖曳（dnd-kit 需要多個 pointermove）；from 為按下的位置 */
async function pointerDrag(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  { shot, beforeDrop }: { shot?: string; beforeDrop?: () => Promise<void> } = {},
) {
  const a = (await from.boundingBox())!;
  const ax = a.x + Math.min(a.width / 2, 40);
  const ay = a.y + a.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 8, ay - 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.move(to.x + 2, to.y, { steps: 2 });
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}` });
  if (beforeDrop) await beforeDrop();
  await page.mouse.up();
  // dnd-kit 在放下後約 50ms 內會攔下接著的 click
  await page.waitForTimeout(150);
}

/** 鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽） */
async function key(page: Page, k: string) {
  await page.keyboard.press(k);
  await page.waitForTimeout(150);
}

async function newLoggedIn(browser: Browser, user: (typeof E2E_USERS)[keyof typeof E2E_USERS], next: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await loginViaUi(page, user, next);
  return { context, page };
}

test('拖曳排程：預覽與氣泡、放下排程、重整保留、復原 / 重做', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const errors = collectErrors(page);
  const req = page.request;
  const users = (await (await req.get('/api/users')).json()) as { id: number; username: string }[];
  managerId = users.find((u) => u.username === E2E_USERS.manager.username)!.id;
  memberId = users.find((u) => u.username === E2E_USERS.member.username)!.id;
  const create = async (data: Record<string, unknown>) =>
    ((await (await req.post('/api/tasks', { headers: json, data })).json()) as ApiTask).id;
  ids.s1 = await create({ title: T.s1, assigneeId: managerId, startDate: day(0), dueDate: day(2) });
  ids.s2 = await create({ title: T.s2, assigneeId: memberId, startDate: day(1), dueDate: day(3) });
  ids.u1 = await create({ title: T.u1, assigneeId: managerId });
  ids.u2 = await create({ title: T.u2, assigneeId: managerId, estimateHours: 12 });
  ids.u3 = await create({ title: T.u3, assigneeId: managerId });
  ids.u4 = await create({ title: T.u4, assigneeId: managerId });
  ids.u5 = await create({ title: T.u5, assigneeId: managerId });

  await page.goto(GANTT_URL());
  await expect(page.getByTestId(`gantt-bar-${ids.s1}`)).toBeVisible();
  await expect(unscheduledRow(page, ids.u1)).toBeVisible();

  // 把手：hover 才顯示；有中文標籤；「排入日期」仍在
  await unscheduledRow(page, ids.u1).hover();
  await expect(handleOf(page, ids.u1)).toHaveAttribute('aria-label', `拖曳「${T.u1}」到時間軸排程`);
  await expect(handleOf(page, ids.u1)).toHaveCSS('opacity', '1');
  await expect(unscheduledRow(page, ids.u1).getByRole('button', { name: '排入日期' })).toBeVisible();

  // 整列按住（從標題處）拖到管理者那一組、今天 + 5 → 預覽 3 天，氣泡顯示日期區間
  const x5 = await dayX(page, 5);
  const yManager = await rowY(page, `t${ids.s1}`);
  const patched = page.waitForResponse(
    (r) => r.url().endsWith(`/api/tasks/${ids.u1}`) && r.request().method() === 'PATCH',
  );
  await pointerDrag(
    page,
    unscheduledRow(page, ids.u1).locator('.gantt-unscheduled-title'),
    { x: x5, y: yManager },
    {
      shot: 'dragging-1280.png',
      beforeDrop: async () => {
        await expect(bubble(page)).toContainText(`${md(5)} – ${md(7)}（3 天）`);
        await expect(bubble(page)).not.toContainText('指派給');
        await expect(page.getByTestId('gantt-sched-preview')).toBeVisible();
        await expect(page.locator(`[data-row-key="u${managerId}"]`)).toHaveClass(/is-drop-target/);
        await expect(page.locator('.gantt-sched-col')).toHaveCount(1);
      },
    },
  );
  expect((await patched).status()).toBe(200);
  // 樂觀更新：立刻離開未排程區、長條出現在該日期且寬 3 天
  await expect(unscheduledRow(page, ids.u1)).toHaveCount(0);
  const bar = page.getByTestId(`gantt-bar-${ids.u1}`);
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  expect(Math.round(barBox.x - (x5 - DW / 2))).toBe(0);
  expect(Math.round(barBox.width)).toBe(3 * DW);
  await expect(page.locator(`[data-row-key="t${ids.u1}"]`)).toHaveClass(/is-flash/);
  await expect(page.getByText(`已排程『${T.u1}』：${md(5)} – ${md(7)}`)).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dropped-1280.png` });
  expect(await getTask(req, ids.u1)).toMatchObject({
    startDate: day(5),
    dueDate: day(7),
    assigneeId: managerId,
  });

  // 重整後保留
  await page.reload();
  await expect(page.getByTestId(`gantt-bar-${ids.u1}`)).toBeVisible();
  await expect(unscheduledRow(page, ids.u1)).toHaveCount(0);

  // 重整會清空復原堆疊 → 再排一次以測試復原 / 重做（U2：預估 12 小時 → 2 天）
  const x10 = await dayX(page, 10);
  await unscheduledRow(page, ids.u2).hover();
  await pointerDrag(
    page,
    handleOf(page, ids.u2),
    { x: x10, y: await rowY(page, `t${ids.s1}`) },
    {
      beforeDrop: () => expect(bubble(page)).toContainText(`${md(10)} – ${md(11)}（2 天）`),
    },
  );
  await expect.poll(async () => (await getTask(req, ids.u2)).dueDate).toBe(day(11));
  expect((await getTask(req, ids.u2)).startDate).toBe(day(10));
  await expect(page.getByTestId(`gantt-bar-${ids.u2}`)).toBeVisible();

  // Ctrl+Z → 回到未排程；Ctrl+Shift+Z → 再排程
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(page.getByText(/已復原：排程『/)).toBeVisible();
  await expect.poll(async () => (await getTask(req, ids.u2)).startDate).toBeNull();
  expect((await getTask(req, ids.u2)).dueDate).toBeNull();
  await expect(unscheduledRow(page, ids.u2)).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await getTask(req, ids.u2)).startDate).toBe(day(10));
  await expect(page.getByTestId(`gantt-bar-${ids.u2}`)).toBeVisible();
  await expect(unscheduledRow(page, ids.u2)).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('拖曳排程：依負責人分組拖到別人的列 → 改指派（氣泡與 toast 寫明）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, GANTT_URL());
  const req = page.request;
  await expect(page.getByTestId(`gantt-bar-${ids.s2}`)).toBeVisible();
  const yMember = await rowY(page, `t${ids.s2}`);
  await unscheduledRow(page, ids.u3).hover();
  await pointerDrag(
    page,
    handleOf(page, ids.u3),
    { x: await dayX(page, 3), y: yMember },
    {
      beforeDrop: async () => {
        await expect(bubble(page)).toContainText(`${md(3)} – ${md(5)}（3 天）`);
        await expect(bubble(page)).toContainText(`同時指派給 ${E2E_USERS.member.displayName}`);
        await expect(page.locator(`[data-row-key="u${memberId}"]`)).toHaveClass(/is-drop-target/);
      },
    },
  );
  await expect.poll(async () => (await getTask(req, ids.u3)).assigneeId).toBe(memberId);
  expect(await getTask(req, ids.u3)).toMatchObject({ startDate: day(3), dueDate: day(5) });
  await expect(page.getByText(`同時指派給 ${E2E_USERS.member.displayName}`)).toBeVisible();
  await expect(page.getByTestId(`gantt-bar-${ids.u3}`)).toBeVisible();
});

test('拖曳排程：拖回未排程區 = 取消；拖曳中 Esc = 取消', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, GANTT_URL());
  const req = page.request;
  await expect(page.getByTestId(`gantt-bar-${ids.s1}`)).toBeVisible();
  let patchCount = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/api/tasks/${ids.u5}`)) patchCount += 1;
  });

  // 先移到時間軸（出現預覽），再拖回未排程區放開
  const yManager = await rowY(page, `t${ids.s1}`);
  const x4 = await dayX(page, 4);
  await unscheduledRow(page, ids.u5).hover();
  const h = (await handleOf(page, ids.u5).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 10, h.y, { steps: 4 });
  await page.mouse.move(x4, yManager, { steps: 16 });
  await expect(bubble(page)).toBeVisible();
  const head = (await page.locator('.gantt-unscheduled-head').boundingBox())!;
  await page.mouse.move(head.x + 400, head.y + head.height / 2, { steps: 12 });
  await expect(bubble(page)).toHaveCount(0);
  await expect(page.locator('.gantt-sched-overlay')).toContainText(T.u5);
  await expect(live(page)).toHaveText('不在時間軸上，放開將取消');
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(live(page)).toHaveText(`已取消排程『${T.u5}』`);
  await expect(unscheduledRow(page, ids.u5)).toBeVisible();

  // Esc 取消
  await unscheduledRow(page, ids.u5).hover();
  const h2 = (await handleOf(page, ids.u5).boundingBox())!;
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h2.x + 10, h2.y, { steps: 4 });
  await page.mouse.move(x4, yManager, { steps: 16 });
  await expect(bubble(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bubble(page)).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(patchCount).toBe(0);
  expect(await getTask(req, ids.u5)).toMatchObject({ startDate: null, dueDate: null });
  // 拖曳中按 Esc 不會關掉頁面上的其他東西；未排程列仍在
  await expect(unscheduledRow(page, ids.u5)).toBeVisible();
});

test('拖曳排程：鍵盤（Space 拿起、←→ 日期、↑↓ 分組列、Space 放下、Esc 取消）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, GANTT_URL());
  const req = page.request;
  await expect(page.getByTestId(`gantt-bar-${ids.s1}`)).toBeVisible();

  // Esc 取消
  await handleOf(page, ids.u5).focus();
  await key(page, 'Space');
  await expect(live(page)).toContainText(`已拿起『${T.u5}』`);
  await expect(live(page)).toContainText(`預計排程 ${md(0)} 到 ${md(2)}`);
  await key(page, 'ArrowRight');
  await expect(live(page)).toHaveText(`預計排程 ${md(1)} 到 ${md(3)}`);
  await key(page, 'Escape');
  await expect(live(page)).toHaveText(`已取消排程『${T.u5}』`);
  expect(await getTask(req, ids.u5)).toMatchObject({ startDate: null, dueDate: null });

  // 拿起 → 右移兩天 → ↑ 到「一般成員」列（改指派）→ ↓ 回自己的列 → Space 放下
  await handleOf(page, ids.u4).focus();
  await key(page, 'Space');
  await key(page, 'ArrowRight');
  await key(page, 'ArrowRight');
  await expect(live(page)).toHaveText(`預計排程 ${md(2)} 到 ${md(4)}`);
  await key(page, 'ArrowUp');
  await expect(live(page)).toHaveText(
    `預計排程 ${md(2)} 到 ${md(4)}，指派給 ${E2E_USERS.member.displayName}`,
  );
  await expect(bubble(page)).toContainText(`同時指派給 ${E2E_USERS.member.displayName}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/keyboard-1280.png` });
  await key(page, 'ArrowDown');
  await expect(live(page)).toHaveText(`預計排程 ${md(2)} 到 ${md(4)}`);
  await key(page, 'Space');
  await expect(live(page)).toHaveText(`已排程『${T.u4}』：${md(2)} 到 ${md(4)}`);
  await expect.poll(async () => (await getTask(req, ids.u4)).startDate).toBe(day(2));
  expect(await getTask(req, ids.u4)).toMatchObject({ dueDate: day(4), assigneeId: managerId });
  // 焦點移到新長條所在列
  await expect(page.locator(`[data-row-key="t${ids.u4}"]`)).toBeFocused();
});

test('拖曳排程：768 寬把手常駐、拖曳中截圖', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await loginViaUi(page, E2E_USERS.admin, GANTT_URL());
  await expect(page.getByTestId(`gantt-bar-${ids.s1}`)).toBeVisible();
  await expect(handleOf(page, ids.u5)).toHaveCSS('opacity', '1');
  const x = await dayX(page, 3);
  const y = await rowY(page, `t${ids.s1}`);
  await pointerDrag(
    page,
    handleOf(page, ids.u5),
    { x, y },
    {
      shot: 'dragging-768.png',
      beforeDrop: async () => {
        await expect(bubble(page)).toContainText(`${md(3)} – ${md(5)}（3 天）`);
        // 不實際排程：Esc 取消
        await page.keyboard.press('Escape');
      },
    },
  );
  expect(await getTask(page.request, ids.u5)).toMatchObject({ startDate: null, dueDate: null });
  if (SHOTS) {
    await handleOf(page, ids.u5).focus();
    await key(page, 'Space');
    await key(page, 'ArrowRight');
    await page.screenshot({ path: `${SHOTS}/keyboard-768.png` });
    await key(page, 'Escape');
  }
});

test('拖曳排程：沒有 tasks.edit 看不到把手', async ({ browser }) => {
  const root = await newLoggedIn(browser, E2E_USERS.admin, '/tasks/list');
  try {
    const res = await root.page.request.put('/api/admin/permissions', {
      headers: json,
      data: { changes: [{ role: 'user', capability: 'tasks.edit', allowed: false }] },
    });
    expect(res.status()).toBe(200);
    const member = await newLoggedIn(browser, E2E_USERS.member, GANTT_URL());
    await expect(unscheduledRow(member.page, ids.u5)).toBeVisible();
    await unscheduledRow(member.page, ids.u5).hover();
    await expect(member.page.locator('.gantt-sched-handle')).toHaveCount(0);
    await member.context.close();
    // admin（root）仍有把手
    await root.page.goto(GANTT_URL());
    await expect(handleOf(root.page, ids.u5)).toHaveCount(1);
  } finally {
    await root.page.request.put('/api/admin/permissions', {
      headers: json,
      data: { changes: [{ role: 'user', capability: 'tasks.edit', allowed: true }] },
    });
    await root.context.close();
  }
});
