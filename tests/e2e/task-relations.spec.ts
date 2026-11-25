import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// feat/task-relations：相關任務（新增 → 清單連結數 → 跳轉 → 移除）與複製任務
test.describe.configure({ mode: 'serial' });

type ApiTask = { id: number; title: string; statusId: number; relationCount?: number };

const shots = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.waitForTimeout(400); // 等進場動畫結束
  await page.screenshot({ path: `${shots}/${name}.png` });
}

async function createTask(page: Page, title: string, extra: Record<string, unknown> = {}): Promise<ApiTask> {
  const res = await page.request.post('/api/tasks', { data: { title, ...extra } });
  expect(res.status()).toBe(201);
  return (await res.json()) as ApiTask;
}

async function fetchTasks(page: Page, q: string): Promise<ApiTask[]> {
  const res = await page.request.get(`/api/tasks?q=${encodeURIComponent(q)}`);
  return (await res.json()) as ApiTask[];
}

test('相關任務：新增、清單連結數、跳轉、移除', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const P = `REL-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const a = await createTask(page, `${P} ntu ranking new workflow`);
  const b = await createTask(page, `${P} pyDMS related repo integration mechanism`);

  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`/tasks/list?q=${P}&task=${a.id}`);
    const drawer = page.locator('.task-drawer');
    const section = drawer.getByTestId('related-tasks');
    await expect(section.getByText('還沒有相關任務')).toBeVisible();

    // 開啟搜尋選單 → 輸入關鍵字 → 鍵盤選取 Enter 加入
    await section.getByRole('button', { name: '新增關聯' }).click();
    const search = page.getByRole('combobox', { name: '搜尋要關聯的任務' });
    await expect(search).toBeFocused();
    await search.fill(`${P} pyDMS`);
    const option = page.getByRole('option', { name: /pyDMS related repo/ });
    await expect(option).toBeVisible();
    // 自己不會出現在結果中
    await search.fill(P);
    await expect(page.getByRole('option')).toHaveCount(1);
    await shot(page, `${width}-relation-search`);
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(search).toBeHidden();
    const row = section.getByRole('button', { name: /開啟相關任務「.*pyDMS/ });
    await expect(row).toBeVisible();
    await shot(page, `${width}-related-section`);

    // 清單出現連結數（兩端都有）
    const badgeA = page.locator(`.tl-row--task[data-task-id="${a.id}"]`).getByTestId('relation-badge');
    const badgeB = page.locator(`.tl-row--task[data-task-id="${b.id}"]`).getByTestId('relation-badge');
    await expect(badgeA).toHaveAccessibleName('1 個相關任務');
    await expect(badgeB).toHaveText('1');
    expect((await fetchTasks(page, P)).map((t) => t.relationCount)).toEqual([1, 1]);

    // 點擊跳轉 → 抽屜切換到 B，B 也看得到 A；返回鍵回到 A
    await row.click();
    await expect(page).toHaveURL(new RegExp(`task=${b.id}`));
    await expect(drawer.getByTestId('related-tasks').getByText(/ntu ranking new workflow/)).toBeVisible();
    await shot(page, `${width}-jumped`);
    await drawer.getByRole('button', { name: /^返回/ }).click();
    await expect(page).toHaveURL(new RegExp(`task=${a.id}`));

    // 移除（可復原）
    const sectionA = page.locator('.task-drawer').getByTestId('related-tasks');
    await sectionA.getByRole('button', { name: /移除相關任務/ }).click();
    await expect(sectionA.getByText('還沒有相關任務')).toBeVisible();
    await expect(page.getByText('已移除相關任務')).toBeVisible();
    await expect(badgeA).toHaveCount(0);
    await expect(badgeB).toHaveCount(0);
  }

  // 看板卡片也顯示連結數
  const rel = await page.request.post(`/api/tasks/${a.id}/relations`, { data: { targetId: b.id } });
  expect(rel.status()).toBe(201);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/tasks/kanban?q=${P}`);
  await expect(page.locator(`.kanban-card[data-task-id="${a.id}"]`).getByTestId('relation-badge')).toHaveText(
    '1',
  );
  await shot(page, '1280-kanban-badge');
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`/tasks/list?q=${P}`);
    await expect(
      page.locator(`.tl-row--task[data-task-id="${b.id}"]`).getByTestId('relation-badge'),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await shot(page, `${width}-list-badge`);
  }

  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('複製任務：預設選項 → 新任務在待辦並與原任務相關', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const P = `DUP-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const statuses = (await (await page.request.get('/api/statuses')).json()) as {
    id: number;
    category: string;
  }[];
  const doing = statuses.find((s) => s.category === 'doing')!;
  const todo = statuses.find((s) => s.category === 'todo')!;
  const src = await createTask(page, `${P} 原任務`, {
    statusId: doing.id,
    description: '要帶過去的描述',
    priority: 'high',
  });

  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`/tasks/list?q=${P}&task=${src.id}`);
    const drawer = page.locator('.task-drawer');
    await expect(drawer.getByTestId('related-tasks')).toBeVisible();
    if (width === 1280) {
      // 選單開啟
      await drawer.getByRole('button', { name: '更多動作' }).click();
      await page.getByRole('menuitem', { name: /複製任務/ }).click();
    } else {
      // 快速鍵 D（focus 在抽屜內）
      await drawer.getByRole('button', { name: '關閉任務詳情' }).focus();
      await page.keyboard.press('d');
    }
    const dialog = page.getByRole('dialog', { name: '複製任務' });
    await expect(dialog).toBeVisible();
    const title = dialog.getByLabel('標題');
    await expect(title).toHaveValue(`${P} 原任務（複製）`);
    for (const label of ['描述', '自訂欄位', '開始日與到期日', '負責人', '預估工時', '優先度']) {
      await expect(dialog.getByLabel(label, { exact: true })).toBeChecked();
    }
    await expect(dialog.getByLabel('並與原任務建立相關連結')).toBeChecked();
    await shot(page, `${width}-duplicate-dialog`);
    if (width === 768) {
      // Esc 取消
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      continue;
    }
    // Ctrl+Enter 送出
    await title.press('Control+Enter');
    await expect(dialog).toBeHidden();
    // toast 標題（名稱截斷為 20 字）
    await expect(page.getByText(new RegExp(`已建立「${P}`))).toBeVisible();
    // 抽屜切換到新任務並聚焦標題
    await expect(page).not.toHaveURL(new RegExp(`task=${src.id}(&|$)`));
    await expect(drawer.locator('.tl-drawer-title-field')).toBeFocused();
    await expect(drawer.getByTestId('related-tasks').getByText(`${P} 原任務`, { exact: true })).toBeVisible();
  }

  const all = await fetchTasks(page, P);
  const copy = all.find((t) => t.title === `${P} 原任務（複製）`)!;
  expect(copy).toBeTruthy();
  expect(copy.statusId).toBe(todo.id);
  expect(copy.relationCount).toBe(1);
  const detail = (await (await page.request.get(`/api/tasks/${copy.id}`)).json()) as {
    description: string;
    priority: string;
    progress: number;
  };
  expect(detail).toMatchObject({ description: '要帶過去的描述', priority: 'high', progress: 0 });
  // 清單：新任務在待辦群組，原任務顯示連結數
  await page.goto(`/tasks/list?q=${P}`);
  await expect(
    page.locator(`.tl-row--task[data-task-id="${src.id}"]`).getByTestId('relation-badge'),
  ).toHaveText('1');

  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
