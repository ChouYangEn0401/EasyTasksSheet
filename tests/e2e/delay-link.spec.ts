import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 延遲鏈（docs/design/delay-link.md）：在詳情建立 A→B→C 依賴 → 看板變色並顯示延後 → 延遲鏈分頁顯示整條鏈與最長路徑
// → 嘗試建立循環被拒 → A 完成後 B 不再被擋；成員沒有 tasks.edit 時不可新增（結尾還原權限）。
// 截圖：設定 SHOTS_DIR 時輸出 1280 / 768 兩種寬度。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const T = { a: `延遲A-${stamp}`, b: `延遲B-${stamp}`, c: `延遲C-${stamp}` };
const json = { 'Content-Type': 'application/json' };
const shots = process.env.SHOTS_DIR;

type ApiTask = { id: number; title: string };

const pad = (n: number) => String(n).padStart(2, '0');
function dayStr(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const md = (offset: number) => dayStr(offset).slice(5).replace('-', '/');

async function createTask(req: APIRequestContext, data: Record<string, unknown>): Promise<ApiTask> {
  const res = await req.post('/api/tasks', { headers: json, data });
  expect(res.status()).toBe(201);
  return (await res.json()) as ApiTask;
}
async function doneStatusId(req: APIRequestContext): Promise<number> {
  const list = (await (await req.get('/api/statuses')).json()) as { id: number; category: string }[];
  return list.find((s) => s.category === 'done')!.id;
}

const drawer = (page: Page) => page.locator('aside.task-drawer');
const depSection = (page: Page) => drawer(page).getByTestId('dep-section');
const card = (page: Page, title: string) => page.getByRole('listitem', { name: new RegExp(`^${title}，`) });

async function addBlocker(page: Page, taskId: number, blockerTitle: string) {
  await page.goto(`/tasks/kanban?q=${stamp}&task=${taskId}`);
  await expect(depSection(page)).toBeVisible();
  await depSection(page).getByRole('button', { name: '新增前置任務' }).click();
  const search = page.getByRole('combobox', { name: '搜尋要連結的任務' });
  await search.fill(blockerTitle);
  await expect(page.getByRole('option', { name: blockerTitle })).toBeVisible();
  await search.press('Enter');
}

async function shoot(page: Page, name: string, fn?: () => Promise<void>) {
  if (!shots) return;
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    if (fn) await fn();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

test('依賴：建立 A→B→C、看板標示、延遲鏈、循環被拒、完成後解除', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin, '/tasks/delay-link');
  const req = page.request;

  // 分頁在甘特圖後面；空狀態（此 spec 之前沒有任何依賴時）
  const tabs = page.getByRole('navigation', { name: '任務檢視' }).getByRole('link');
  await expect(tabs).toHaveText(['清單', '看板', '甘特圖', '延遲鏈']);
  const empty = page.getByText('目前沒有依賴關係');
  if (await empty.isVisible().catch(() => false)) {
    await expect(page.getByText('在任務詳情的「依賴」加入前置任務，就能在這裡看到整條鏈')).toBeVisible();
    await shoot(page, 'delay-link-empty');
  }

  const A = await createTask(req, { title: T.a, dueDate: dayStr(5) });
  const B = await createTask(req, { title: T.b, startDate: dayStr(2), dueDate: dayStr(4) });
  const C = await createTask(req, { title: T.c, dueDate: dayStr(6) });

  // 在詳情建立依賴：B 等 A、C 等 B
  await addBlocker(page, B.id, T.a);
  await expect(page.getByText('已加入前置任務').first()).toBeVisible();
  await expect(depSection(page).getByTestId('dep-row').filter({ hasText: T.a })).toBeVisible();
  await expect(depSection(page).getByTestId('dep-self')).toContainText(`預計延後 4 天（到 ${md(8)}）`);
  await addBlocker(page, C.id, T.b);
  await expect(depSection(page).getByTestId('dep-row').filter({ hasText: T.b })).toContainText(
    `預計延後 4 天（到 ${md(8)}）`,
  );
  await shoot(page, 'drawer-deps');

  // 看板：B / C 為「等待中」並顯示延後；A 顯示「擋住 1」
  await page.goto(`/tasks/kanban?q=${stamp}`);
  await expect(card(page, T.b)).toHaveClass(/dep-card--blocked/);
  await expect(card(page, T.b).getByTestId('dep-waiting')).toHaveText(`等待中 · 預計延後 4 天 → ${md(8)}`);
  await expect(card(page, T.c).getByTestId('dep-waiting')).toHaveText(`等待中 · 預計延後 3 天 → ${md(9)}`);
  await expect(card(page, T.a)).not.toHaveClass(/dep-card--blocked/);
  await expect(card(page, T.a).getByTestId('dep-blocks')).toHaveText('擋住 1');
  await expect(card(page, T.b).getByTestId('dep-lock')).toBeVisible();
  await shoot(page, 'kanban-blocked');
  // 顯示開關：關閉後不顯示，重新整理後仍記得；再打開
  const toggle = page.getByLabel('顯示依賴標示');
  await toggle.uncheck();
  await expect(card(page, T.b)).not.toHaveClass(/dep-card--blocked/);
  await page.reload();
  await expect(page.getByLabel('顯示依賴標示')).not.toBeChecked();
  await page.getByLabel('顯示依賴標示').check();
  await expect(card(page, T.b)).toHaveClass(/dep-card--blocked/);

  // 清單：標題旁鎖頭
  await page.goto(`/tasks/list?q=${stamp}`);
  await expect(page.getByTestId('dep-lock')).toHaveCount(2);

  // 延遲鏈分頁
  await page.goto(`/tasks/delay-link?q=${stamp}`);
  await expect(page.getByTestId('dl-summary')).toHaveText('共 1 條依賴鏈・最長預計延後 4 天');
  const chain = page.getByTestId('dl-chain');
  await expect(chain).toHaveCount(1);
  await expect(chain.locator('.dl-node')).toHaveCount(3);
  await expect(chain.locator('.dl-node.is-critical')).toHaveCount(3);
  await expect(chain.getByText('強調的路徑決定了最終完成日')).toBeVisible();
  await expect(chain.locator(`[data-node-id="${A.id}"]`)).toContainText('可立即開始');
  await expect(chain.locator(`[data-node-id="${B.id}"]`)).toContainText('+4 天');
  await expect(chain.locator('.dl-edge')).toHaveCount(2);
  // 鍵盤：→ 沿箭頭移動，Enter 開啟詳情
  await chain.locator(`[data-node-id="${A.id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await expect(chain.locator(`[data-node-id="${B.id}"]`)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`task=${B.id}`));
  await page.keyboard.press('Escape');
  await page.goto(`/tasks/delay-link?q=${stamp}`);
  await expect(page.getByTestId('dl-chain')).toBeVisible();
  await shoot(page, 'delay-link-chain');

  // 循環：A 等 C → 拒絕並顯示中文訊息
  await addBlocker(page, A.id, T.c);
  await expect(page.getByRole('alert').filter({ hasText: '會形成循環' })).toContainText(
    `無法建立：「${T.c}」 → 「${T.a}」 → 「${T.b}」 → 「${T.c}」 會形成循環`,
  );
  await page.keyboard.press('Escape');

  // A 完成 → B 不再被擋（紀錄保留，可在延遲鏈顯示已完成的前置任務）
  await req.patch(`/api/tasks/${A.id}`, { headers: json, data: { statusId: await doneStatusId(req) } });
  await page.goto(`/tasks/kanban?q=${stamp}`);
  await expect(card(page, T.b)).not.toHaveClass(/dep-card--blocked/);
  await expect(card(page, T.c)).toHaveClass(/dep-card--blocked/);
  await page.goto(`/tasks/delay-link?q=${stamp}`);
  await expect(page.getByTestId('dl-chain').locator('.dl-node')).toHaveCount(2);
  await page.getByLabel('顯示已完成的前置任務').check();
  await expect(page.getByTestId('dl-chain').locator('.dl-node')).toHaveCount(3);
  await expect(page.getByTestId('dl-chain').locator('.dl-node.is-done')).toHaveCount(1);
  await page.getByLabel('顯示已完成的前置任務').uncheck();

  // 移除依賴（附復原）
  await page.goto(`/tasks/list?q=${stamp}&task=${C.id}`);
  const row = depSection(page).getByTestId('dep-row').filter({ hasText: T.b });
  await row.hover();
  await row.getByRole('button', { name: `移除依賴「${T.b}」` }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: '復原' }).click();
  await expect(depSection(page).getByTestId('dep-row').filter({ hasText: T.b })).toBeVisible();

  // 409（循環被拒）與登入前的 401 為預期內的請求失敗
  expect(errors.filter((e) => !/\b(401|409)\b/.test(e))).toEqual([]);
});

test('成員沒有 tasks.edit 時不能新增依賴（結尾還原）', async ({ browser }) => {
  const rootCtx = await browser.newContext();
  const root = await rootCtx.newPage();
  await loginViaUi(root, E2E_USERS.admin, '/');
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  try {
    const tasks = (await (await root.request.get(`/api/tasks?q=${stamp}`)).json()) as ApiTask[];
    const B = tasks.find((t) => t.title === T.b)!;
    const C = tasks.find((t) => t.title === T.c)!;
    const res = await root.request.put('/api/admin/permissions', {
      headers: json,
      data: { changes: [{ role: 'user', capability: 'tasks.edit', allowed: false }] },
    });
    expect(res.status()).toBe(200);
    await loginViaUi(member, E2E_USERS.member, `/tasks/list?q=${stamp}&task=${C.id}`);
    await expect(depSection(member)).toBeVisible();
    await expect(depSection(member).getByTestId('dep-row').first()).toBeVisible();
    await expect(depSection(member).getByRole('button', { name: '新增前置任務' })).toHaveCount(0);
    await expect(depSection(member).getByRole('button', { name: /移除依賴/ })).toHaveCount(0);
    const post = await member.request.post(`/api/tasks/${B.id}/dependencies`, {
      headers: json,
      data: { direction: 'blocks', targetId: C.id },
    });
    expect(post.status()).toBe(403);
    expect((await member.request.get('/api/tasks/delay-chains')).status()).toBe(200);
  } finally {
    await root.request.post('/api/admin/permissions/reset', { headers: json, data: {} });
    await rootCtx.close();
    await memberCtx.close();
  }
});

test('大鏈（55 個任務）可正常顯示', async ({ page }) => {
  test.setTimeout(120_000);
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const req = page.request;
  const tag = `大鏈-${stamp}`;
  const ids: number[] = [];
  for (let i = 0; i < 55; i++) {
    const t = await createTask(req, {
      title: `${tag}-${String(i + 1).padStart(2, '0')}`,
      ...(i % 4 !== 3 && { dueDate: dayStr(2 + Math.floor(i / 5)) }),
    });
    ids.push(t.id);
  }
  // 每層 5 個，往下一層各連 1～2 條；偶爾跨層
  for (let i = 5; i < 55; i++) {
    const blockers = new Set([ids[i - 5]!, ids[Math.max(0, i - 5 - (i % 2))]!]);
    if (i % 7 === 0 && i >= 10) blockers.add(ids[i - 10]!);
    for (const b of blockers) {
      const r = await req.post(`/api/tasks/${ids[i]}/dependencies`, {
        headers: json,
        data: { direction: 'blocked_by', targetId: b, ...(i % 9 === 0 && { lagDays: 1 }) },
      });
      expect([200, 201]).toContain(r.status());
    }
  }
  const t0 = Date.now();
  await page.goto(`/tasks/delay-link?q=${encodeURIComponent(tag)}`);
  const chain = page.getByTestId('dl-chain');
  await expect(chain.locator('.dl-node')).toHaveCount(55);
  expect(Date.now() - t0).toBeLessThan(10_000);
  await expect(chain.locator('.dl-lag').first()).toBeVisible();
  await shoot(page, 'delay-link-big');
  // 窄螢幕：由上而下堆疊
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(chain.locator('.dl-stack .dl-node')).toHaveCount(55);
  await page.setViewportSize({ width: 1280, height: 720 });
  // 清除：大量有日期的任務會影響之後的甘特圖 spec
  for (const id of ids) await req.delete(`/api/tasks/${id}`, { headers: json });
});
