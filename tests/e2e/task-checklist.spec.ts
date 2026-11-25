import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// feat/task-checklist：新增 → 勾選 → 進度 → 列表徽章 → 拖曳排序 → 貼上多行 → 清除已完成 → 重整後仍在
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.CHECKLIST_SHOTS;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const cl = page.getByTestId('checklist');
  if (await cl.count()) await cl.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function pasteInto(input: Locator, text: string) {
  await input.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

const texts = (page: Page, list: 'open' | 'done' = 'open') =>
  page
    .getByRole('list', { name: list === 'open' ? '待辦項目' : '已完成的待辦' })
    .locator('[data-checklist-row] .cl-text')
    .allTextContents();

test('待辦清單：新增、勾選、進度、徽章、排序、貼上、清除、重整', async ({ page }) => {
  test.setTimeout(120_000);
  const P = `CL-${Date.now()}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const errors = collectErrors(page);
  const created = await page.request.post('/api/tasks', { data: { title: `${P} 任務` } });
  expect(created.ok()).toBeTruthy();
  const task = (await created.json()) as { id: number };
  await page.request.post('/api/tasks', { data: { title: `${P} 沒有清單` } });

  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const list = page.getByTestId('checklist');
  await expect(list.getByText('待辦清單', { exact: true })).toBeVisible();
  // 空狀態：沒有進度，只有說明與新增列
  await expect(list.getByText('把工作拆成小步驟')).toBeVisible();
  await expect(page.getByTestId('checklist-progress')).toHaveCount(0);
  await expect(page.getByTestId('checklist-badge')).toHaveCount(0);
  await page.waitForTimeout(500);
  await shot(page, '1280-empty');

  // ── 連續新增 ──
  const add = list.getByRole('textbox', { name: '新增待辦' });
  for (const t of ['甲', '乙', '丙', '丁', '戊']) {
    await add.fill(t);
    await add.press('Enter');
    await expect(add).toHaveValue('');
  }
  await expect(list.locator('[data-checklist-row]')).toHaveCount(5);
  await expect(page.getByTestId('checklist-progress')).toHaveText('0 / 5');

  // ── 勾選 → 進度 3 / 5 與列表徽章 ──
  for (const t of ['甲', '乙', '丙']) await list.getByRole('checkbox', { name: `標為完成：${t}` }).click();
  await expect(page.getByTestId('checklist-progress')).toHaveText('3 / 5');
  await expect(list.getByRole('progressbar', { name: '待辦清單進度' })).toHaveAttribute('aria-valuenow', '3');
  const badge = page.locator('.tl-row--task', { hasText: `${P} 任務` }).getByTestId('checklist-badge');
  await expect(badge).toHaveText('3/5');
  await expect(badge).toHaveAttribute('aria-label', '待辦清單 3/5 完成');
  await expect(
    page.locator('.tl-row--task', { hasText: `${P} 沒有清單` }).getByTestId('checklist-badge'),
  ).toHaveCount(0);
  await expect(list.getByText('已完成 3 項')).toBeVisible();
  expect(await texts(page, 'done')).toEqual(['甲', '乙', '丙']);
  await shot(page, '1280-progress');

  // ── 拖曳排序（把手）：戊移到丁之前 ──
  expect(await texts(page)).toEqual(['丁', '戊']);
  const rowWu = list.locator('[data-checklist-row]', { hasText: '戊' });
  await rowWu.hover();
  const handle = rowWu.getByRole('button', { name: /拖曳排序：戊/ });
  const hb = (await handle.boundingBox())!;
  const rowDing = (await list.locator('[data-checklist-row]', { hasText: '丁' }).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 10, { steps: 4 });
  await page.mouse.move(hb.x + hb.width / 2, rowDing.y + 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => texts(page)).toEqual(['戊', '丁']);
  // 鍵盤 Alt+↓ 移回
  await list.locator('[data-checklist-row]', { hasText: '戊' }).locator('.cl-text').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => texts(page)).toEqual(['丁', '戊']);

  // ── 就地編輯：Enter 儲存並在下方新增下一項；Esc 結束；空項 Backspace 刪除 ──
  await list.locator('[data-checklist-row]', { hasText: '丁' }).locator('.cl-text').click();
  const editor = list.getByRole('textbox', { name: /編輯待辦：丁/ });
  await editor.fill('丁（改）');
  await editor.press('Enter');
  const next = list.getByRole('textbox', { name: '新增下一項待辦' });
  await expect(next).toBeFocused();
  await next.fill('丁之二');
  await next.press('Enter');
  await next.fill('丁之三');
  await next.press('Enter');
  await next.fill('不會建立');
  await next.press('Escape'); // Esc 取消目前輸入並結束連續新增
  await expect.poll(() => texts(page)).toEqual(['丁（改）', '丁之二', '丁之三', '戊']);
  await list.locator('[data-checklist-row]', { hasText: '丁之三' }).locator('.cl-text').press('F2');
  const e2 = list.getByRole('textbox', { name: /編輯待辦：丁之三/ });
  await e2.fill('');
  await e2.press('Backspace');
  await expect.poll(() => texts(page)).toEqual(['丁（改）', '丁之二', '戊']);
  await list
    .locator('[data-checklist-row]', { hasText: '丁之二' })
    .getByRole('button', { name: /刪除待辦/ })
    .click();
  await expect.poll(() => texts(page)).toEqual(['丁（改）', '戊']);

  // ── 貼上多行：確認後拆成多項（保留勾選）──
  await pasteInto(add, '- [ ] 買牛奶\n- [x] 寄信\n\n  * 開會\n1. 打掃');
  await expect(list.getByText('將建立 4 項，其中 1 項已勾選')).toBeVisible();
  await shot(page, '1280-paste');
  await list.getByRole('button', { name: '建立 4 項' }).click();
  await expect(page.getByText('已建立 4 項待辦')).toBeVisible();
  await expect.poll(() => texts(page)).toEqual(['丁（改）', '戊', '買牛奶', '開會', '打掃']);
  expect(await texts(page, 'done')).toEqual(['甲', '乙', '丙', '寄信']);
  await expect(page.getByTestId('checklist-progress')).toHaveText('4 / 9');
  // 復原
  await page.getByRole('button', { name: '復原' }).click();
  await expect.poll(() => texts(page)).toEqual(['丁（改）', '戊']);
  await expect(page.getByTestId('checklist-progress')).toHaveText('3 / 5');
  // 取消貼上不建立
  await pasteInto(add, 'a\nb');
  await list.getByRole('button', { name: '取消' }).click();
  await expect(list.locator('[data-checklist-row]')).toHaveCount(5);

  // ── 清除已完成 ──
  await list.getByRole('button', { name: '清除已完成' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '清除' }).click();
  await expect(list.getByText(/已完成 \d+ 項/)).toHaveCount(0);
  await expect(page.getByTestId('checklist-progress')).toHaveText('0 / 2');
  await expect(badge).toHaveText('0/2');

  // ── 重整後仍在 ──
  await page.reload();
  await expect(page.getByTestId('checklist-progress')).toHaveText('0 / 2');
  expect(await texts(page)).toEqual(['丁（改）', '戊']);

  // ── 全部完成：徽章變綠色勾、提示低調出現、任務狀態不變 ──
  for (const t of ['丁（改）', '戊']) await list.getByRole('checkbox', { name: `標為完成：${t}` }).click();
  await expect(list.getByText('全部完成')).toBeVisible();
  await expect(badge).toHaveAttribute('aria-label', '待辦清單 2/2 完成');
  await expect(badge).toHaveClass(/is-complete/);
  const after = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as {
    statusId: number;
    checklistTotal: number;
    checklistDone: number;
  };
  expect([after.checklistTotal, after.checklistDone]).toEqual([2, 2]);
  expect(after.statusId).toBe(1);
  for (const t of ['丁（改）', '戊']) await list.getByRole('checkbox', { name: `標為未完成：${t}` }).click();
  await list.locator('[data-checklist-row]', { hasText: '戊' }).getByRole('checkbox').click();

  // ── 看板卡片徽章 ──
  await page.goto(`/tasks/kanban?q=${P}`);
  const card = page.locator('.kanban-card', { hasText: `${P} 任務` });
  await expect(card.getByTestId('checklist-badge')).toHaveText('1/2');
  await shot(page, '1280-kanban');

  // ── 768px ──
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  await expect(page.getByTestId('checklist-progress')).toHaveText('1 / 2');
  await shot(page, '768-progress');
  await pasteInto(
    page.getByTestId('checklist').getByRole('textbox', { name: '新增待辦' }),
    '- [x] 一\n- [ ] 二\n- [ ] 三',
  );
  await expect(page.getByText('將建立 3 項，其中 1 項已勾選')).toBeVisible();
  await shot(page, '768-paste');
  await page.getByRole('button', { name: '取消' }).click();
  await page.goto(`/tasks/list?q=${P}`);
  await expect(
    page.locator('.tl-row--task', { hasText: `${P} 任務` }).getByTestId('checklist-badge'),
  ).toHaveText('1/2');
  await page.mouse.move(700, 800);
  await shot(page, '768-list');

  expect(errors).toEqual([]);
});

test('待辦清單：另一個分頁的變更即時出現，且不覆蓋正在編輯的文字', async ({ browser, page }) => {
  test.setTimeout(90_000);
  const P = `CLR-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const task = (await (await page.request.post('/api/tasks', { data: { title: `${P} 任務` } })).json()) as {
    id: number;
  };
  await page.request.post(`/api/tasks/${task.id}/checklist`, {
    data: { items: [{ text: '甲' }, { text: '乙' }] },
  });
  await page.goto(`/tasks/list?q=${P}&task=${task.id}`);
  const list = page.getByTestId('checklist');
  await expect(page.getByTestId('checklist-progress')).toHaveText('0 / 2');

  // 開始編輯「甲」，另一位成員同時改動
  await list.locator('[data-checklist-row]', { hasText: '甲' }).locator('.cl-text').click();
  const editor = list.getByRole('textbox', { name: /編輯待辦：甲/ });
  await editor.fill('甲（我正在打字）');

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await loginViaUi(page2, E2E_USERS.admin, '/tasks/list');
  const items = (await (await page2.request.get(`/api/tasks/${task.id}/checklist`)).json()) as {
    id: number;
  }[];
  await page2.request.patch(`/api/tasks/${task.id}/checklist/${items[1]!.id}`, { data: { isDone: true } });
  await page2.request.patch(`/api/tasks/${task.id}/checklist/${items[0]!.id}`, {
    data: { text: '甲（別人改的）' },
  });
  await page2.request.post(`/api/tasks/${task.id}/checklist`, { data: { text: '丙（別人加的）' } });

  await expect(page.getByTestId('checklist-progress')).toHaveText('1 / 3');
  await expect(editor).toHaveValue('甲（我正在打字）');
  await editor.press('Escape');
  await expect(list.getByText('丙（別人加的）')).toBeVisible();
  await ctx2.close();
});
