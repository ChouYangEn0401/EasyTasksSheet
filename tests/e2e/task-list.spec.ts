import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// T1 feat/task-list：快速新增 → 就地編輯 → 一鍵完成 → 排序 / 分組 → 自訂欄位 → Drawer
test.describe.configure({ mode: 'serial' });

type ApiTask = {
  id: number;
  title: string;
  statusId: number;
  assigneeId: number | null;
  dueDate: string | null;
  estimateHours: number | null;
  priority: string;
  description: string;
  custom: Record<string, unknown>;
};

async function fetchTasks(page: Page, q: string): Promise<ApiTask[]> {
  const res = await page.request.get(`/api/tasks?q=${encodeURIComponent(q)}`);
  return (await res.json()) as ApiTask[];
}

test('List 檢視：快速新增、就地編輯、狀態、排序、自訂欄位、Drawer', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const P = `T1-${Date.now()}`;
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');

  // 空狀態（全新 DB 時）
  await expect(page.getByText(/共 \d+ 筆/)).toBeVisible();
  if (await page.getByText('共 0 筆').isVisible()) {
    await expect(page.getByText('還沒有任務')).toBeVisible();
  }

  // 以關鍵字篩選，只看本測試建立的任務
  await page.goto(`/tasks/list?q=${P}`);
  await expect(page.getByText('沒有符合條件的任務')).toBeVisible();

  // ── 快速新增：N 聚焦 → Enter 建立 → 保持 focus 連續新增，不需重整即出現 ──
  await page.locator('#main').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('n');
  const quickAdd = page.getByRole('textbox', { name: '快速新增任務' });
  await expect(quickAdd).toBeFocused();
  await quickAdd.fill(`${P} 甲`);
  await quickAdd.press('Enter');
  await expect(quickAdd).toHaveValue('');
  await expect(quickAdd).toBeFocused();
  await quickAdd.fill(`${P} 乙`);
  await quickAdd.press('Enter');
  await expect(quickAdd).toHaveValue('');
  const rows = page.locator('.tl-row--task');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-task-id]:not([data-temp])')).toHaveCount(2);
  await quickAdd.press('Escape');

  // 以 id 定位列（編輯中時列文字會變成輸入框）
  const rowOf = async (title: string) => {
    const id = await page.locator('.tl-row--task', { hasText: title }).getAttribute('data-task-id');
    return page.locator(`.tl-row--task[data-task-id="${id}"]`);
  };
  const rowA = await rowOf(`${P} 甲`);
  const rowB = await rowOf(`${P} 乙`);
  // 依狀態分組：新任務在「待辦」；每列顯示最後更新
  await expect(page.locator('.tl-row--group').first()).toContainText('待辦');
  await expect(rowA.locator('time')).toHaveText('剛剛');

  // ── 就地編輯標題 ──
  await rowA.locator('.tl-field--title .tl-title-text').click();
  const titleInput = rowA.locator('.tl-field--title input');
  await expect(titleInput).toBeFocused();
  await titleInput.fill(`${P} 甲改`);
  await titleInput.press('Enter');
  const rowA2 = rowA;
  await expect(rowA2.locator('.tl-field--title')).toHaveText(`${P} 甲改`);

  // ── 改狀態：點 StatusBadge → 面板選項 ──
  await rowB.locator('.tl-field--status').click();
  await page.getByRole('option', { name: '進行中' }).click();
  await expect(rowB.locator('.tl-field--status')).toContainText('進行中');

  // ── 一鍵完成 ──
  const doneBtn = rowA2.getByRole('button', { name: '標記為完成' });
  await doneBtn.click();
  await expect(doneBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(rowA2.locator('.tl-field--status')).toContainText('完成');

  // ── 負責人 ──
  await rowB.locator('.tl-field--assignee').click();
  await page.getByRole('option', { name: E2E_USERS.admin.displayName }).click();
  await expect(rowB.locator('.tl-field--assignee')).toContainText(E2E_USERS.admin.displayName);

  // ── 日期：到期日早於開始日 → 錯誤；正常日期 → 寫入 ──
  await rowB.locator('.tl-field--startDate').click();
  await page.getByRole('dialog', { name: '開始日' }).locator('input[type="date"]').fill('2026-12-05');
  await expect(rowB.locator('.tl-field--startDate')).toContainText('12/05');
  await rowB.locator('.tl-field--dueDate').click();
  await page.getByRole('dialog', { name: '到期日' }).locator('input[type="date"]').fill('2026-12-01');
  await expect(rowB.getByRole('alert')).toHaveText('到期日不可早於開始日');
  await rowB.locator('.tl-field--dueDate').click();
  await page.getByRole('dialog', { name: '到期日' }).locator('input[type="date"]').fill('2026-12-31');
  await expect(rowB.locator('.tl-field--dueDate')).toContainText('12/31');

  // ── 預估工時：非數字 → 錯誤並回復；2.5 → 寫入 ──
  const est = rowB.locator('.tl-field--estimate');
  await est.click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(rowB.getByRole('alert')).toHaveText('請輸入數字');
  await est.click();
  await page.keyboard.type('2.5');
  await page.keyboard.press('Enter');
  await expect(est).toHaveText('2.5');

  // ── 鍵盤：方向鍵移動、Enter 進入編輯、Esc 取消 ──
  await est.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(rowB.locator('.tl-field--dueDate')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(est.locator('input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(est).toBeFocused();

  // ── 排序：點欄名升冪 → 降冪 → 取消（寫入 URL） ──
  const titleHeader = page.getByRole('columnheader', { name: /^標題/ });
  await titleHeader.locator('.tl-hcell-label').click();
  await expect(page).toHaveURL(/sort=title&dir=asc/);
  await expect(titleHeader).toHaveAttribute('aria-sort', 'ascending');
  await titleHeader.locator('.tl-hcell-label').click();
  await expect(titleHeader).toHaveAttribute('aria-sort', 'descending');
  await titleHeader.locator('.tl-hcell-label').click();
  await expect(page).not.toHaveURL(/sort=/);

  // ── 分組：負責人 → 回到狀態 ──
  await page.getByRole('button', { name: '分組' }).click();
  await page.getByRole('option', { name: '負責人' }).click();
  await expect(page).toHaveURL(/group=assignee/);
  await expect(page.locator('.tl-row--group', { hasText: '未指派' })).toBeVisible();
  await page.getByRole('button', { name: '分組' }).click();
  await page.getByRole('option', { name: '狀態' }).click();
  await expect(page).not.toHaveURL(/group=/);

  // ── 自訂欄位：新增 → 填值 → 改名 → 隱藏 / 顯示 → 刪除（需確認） ──
  await page.locator('.tl-hcell--add').getByRole('button', { name: '新增欄位' }).click();
  const panel = page.getByRole('dialog', { name: '新增欄位' });
  await expect(panel.getByLabel('名稱')).toBeFocused();
  await panel.getByLabel('名稱').fill('狀態');
  await expect(panel.getByText('已有同名欄位')).toBeVisible();
  await expect(panel.getByRole('button', { name: '建立' })).toBeDisabled();
  const propName = `批次${Date.now() % 10000}`;
  await panel.getByLabel('名稱').fill(propName);
  await panel.getByRole('button', { name: '建立' }).click();
  await expect(panel).toHaveCount(0);
  const propHeader = page.getByRole('columnheader', { name: new RegExp(`^${propName}`) });
  await expect(propHeader).toBeVisible();

  const textCell = rowB.locator('.tl-field--text');
  await textCell.click();
  await page.keyboard.type('B-12');
  await page.keyboard.press('Enter');
  await expect(textCell).toHaveText('B-12');

  await propHeader.getByRole('button', { name: `${propName} 欄位選單` }).click();
  await page.getByRole('menuitem', { name: '重新命名' }).click();
  const renameInput = page.getByRole('textbox', { name: '欄位名稱' });
  await renameInput.fill(`${propName}改`);
  await renameInput.press('Enter');
  const renamed = page.getByRole('columnheader', { name: new RegExp(`^${propName}改`) });
  await expect(renamed).toBeVisible();

  await page.getByRole('button', { name: '欄位', exact: true }).click();
  const columnsPanel = page.getByRole('dialog', { name: '欄位' });
  await columnsPanel.getByLabel(`${propName}改`).uncheck();
  await expect(renamed).toHaveCount(0);
  await columnsPanel.getByLabel(`${propName}改`).check();
  await expect(renamed).toBeVisible();
  await page.keyboard.press('Escape');

  await renamed.getByRole('button', { name: `${propName}改 欄位選單` }).click();
  await page.getByRole('menuitem', { name: '刪除欄位' }).click();
  const confirm = page.getByRole('alertdialog', { name: `刪除欄位「${propName}改」？` });
  await expect(confirm.getByRole('button', { name: '取消' })).toBeFocused();
  await confirm.getByRole('button', { name: '刪除欄位' }).click();
  await expect(renamed).toHaveCount(0);

  // ── Drawer：從列開啟、編輯欄位與描述、顯示更新時間 ──
  await rowB.hover();
  await rowB.getByRole('button', { name: '開啟' }).click();
  const drawer = page.getByRole('dialog', { name: `${P} 乙` });
  await expect(drawer).toBeVisible();
  await expect(rowB).toHaveAttribute('data-selected', 'true');
  await expect(drawer.getByText(/更新於/)).toBeVisible();
  await expect(drawer.getByText(/建立於/)).toBeVisible();
  await expect(drawer.getByText('尚未建立自訂欄位')).toBeVisible();
  await drawer.getByLabel('優先度').click();
  await page.getByRole('option', { name: '高', exact: true }).click();
  await expect(drawer.getByLabel('優先度')).toContainText('高');
  const desc = drawer.getByLabel('描述');
  await desc.fill('量測前先校正');
  await desc.press('Control+Enter');
  await expect(drawer.getByText('已儲存')).toBeVisible();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/t1-drawer.png` });
  await drawer.getByRole('button', { name: '關閉任務詳情' }).click();
  await expect(drawer).toHaveCount(0);

  // 後端資料確認
  const tasks = await fetchTasks(page, P);
  const b = tasks.find((t) => t.title === `${P} 乙`)!;
  expect(b).toMatchObject({
    dueDate: '2026-12-31',
    estimateHours: 2.5,
    priority: 'high',
    description: '量測前先校正',
  });
  expect(b.assigneeId).not.toBeNull();
  expect(tasks.some((t) => t.title === `${P} 甲改`)).toBe(true);

  // ── Drawer 刪除任務（需確認） ──
  await rowA2.hover();
  await rowA2.getByRole('button', { name: '開啟' }).click();
  const drawerA = page.getByRole('dialog', { name: `${P} 甲改` });
  await drawerA.getByRole('button', { name: '更多動作' }).click();
  await page.getByRole('menuitem', { name: '刪除任務' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '刪除', exact: true }).click();
  await expect(drawerA).toHaveCount(0);
  await expect(rowA2).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  // 等 SSE 的刪除事件套用完（抽屜離場中不可重抓已刪除任務的子資源而得到 404）
  await page.waitForTimeout(500);

  // 登入前的 /api/auth/me 探測回 401 屬預期
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('List 1280 / 1024 / 768 寬度不產生頁面水平捲軸', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.admin, '/tasks/list');
  const shots = process.env.SHOTS_DIR;
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tasks/list');
    await expect(page.getByRole('grid', { name: '任務清單' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
    if (shots) await page.screenshot({ path: `${shots}/t1-list-${width}.png` });
  }
});
