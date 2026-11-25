import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 多台電腦同步（docs/sync.md、docs/design/sync.md）：manager 建立來源 → 取得一次性金鑰 →
// 以該金鑰推送兩次製造一筆衝突 → 在「待確認衝突」並排比較、逐欄位選擇 → 套用後任務資料正確。
// SYNC_SHOT_DIR 有設定時另存截圖（1280 / 768）。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const SOURCE_NAME = `E2E 筆電 ${stamp}`;
const TITLE = `E2E 同步任務 ${stamp}`;
const uid = (p: string) => `${p}${stamp}${Math.random().toString(36).slice(2, 10)}`.slice(0, 40);
const TASK_UID = uid('t');
const STATUS_UID = uid('s');
const PROJECT_UID = uid('p');
const SHOT_DIR = process.env.SYNC_SHOT_DIR;

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

function pushDoc(task: { title: string; description: string; priority: string; updatedAt: number }) {
  const now = Date.now();
  return {
    format: 'tasks-sheets-export',
    schemaVersion: 1,
    exportedAt: now,
    source: { machineName: 'e2e-laptop', exportedAt: now, since: null, pushId: uid('push') },
    incremental: false,
    batch: { index: 0, total: 1 },
    users: [],
    // 狀態 / 專案以名稱對應中央預設資料；updatedAt 極舊 → 中央較新，不會改到中央
    statuses: [
      {
        uid: STATUS_UID,
        name: '待辦',
        color: 'gray',
        category: 'todo',
        sortOrder: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    projects: [
      {
        uid: PROJECT_UID,
        name: '預設專案',
        color: 'blue',
        isArchived: false,
        sortOrder: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    tasks: [
      {
        uid: TASK_UID,
        projectUid: PROJECT_UID,
        statusUid: STATUS_UID,
        title: task.title,
        description: task.description,
        assigneeUsername: null,
        priority: task.priority,
        startDate: null,
        dueDate: null,
        estimateHours: null,
        progress: 0,
        sortOrder: 1,
        custom: {},
        createdByUsername: null,
        updatedByUsername: null,
        createdAt: now,
        updatedAt: task.updatedAt,
        completedAt: null,
        deletedAt: null,
      },
    ],
  };
}

async function push(request: APIRequestContext, token: string, doc: unknown) {
  const res = await request.post('/api/sync/push', {
    data: doc,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { totals: Record<string, number>; pendingConflicts: number };
}

type Task = { id: number; title: string; description: string; priority: string };

async function findTask(request: APIRequestContext): Promise<Task> {
  const res = await request.get(`/api/tasks?q=${encodeURIComponent(stamp)}`);
  const list = (await res.json()) as Task[];
  const t = list.find(
    (x) => x.title.includes(stamp) || x.title.includes('中央標題') || x.title.includes('上傳標題'),
  );
  expect(t).toBeTruthy();
  return t!;
}

test('一般成員：導覽沒有「資料同步」，頁面與 API 一律拒絕', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member);
  await expect(page.getByRole('navigation', { name: '主要導覽' }).getByText('資料同步')).toHaveCount(0);
  await page.goto('/admin/data/sync');
  await expect(page.getByText('沒有權限')).toBeVisible();
  expect((await page.request.get('/api/admin/sync/sources')).status()).toBe(403);
  expect((await page.request.get('/api/admin/sync/conflicts')).status()).toBe(403);
});

test('管理者：建立來源 → 一次性金鑰 → 推送製造衝突 → 逐欄位決定 → 任務資料正確', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.manager);
  await page.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '資料同步' }).click();
  await expect(page).toHaveURL(/\/admin\/data\/sync$/);
  await expect(page.getByRole('tab', { name: '同步來源' })).toHaveAttribute('aria-selected', 'true');

  // 建立來源
  await page.getByRole('button', { name: '新增同步來源' }).click();
  const create = page.getByRole('dialog', { name: '新增同步來源' });
  await create.getByLabel('名稱').fill(SOURCE_NAME);
  await create.getByRole('button', { name: '建立並產生金鑰' }).click();
  const tokenDialog = page.getByRole('alertdialog', { name: `已建立「${SOURCE_NAME}」` });
  await expect(tokenDialog.getByText('金鑰只會顯示這一次')).toBeVisible();
  const token = (await tokenDialog.getByLabel('同步金鑰').textContent())!.trim();
  expect(token).toMatch(/^tss_/);
  await expect(tokenDialog.getByLabel('上傳命令')).toContainText(`sync-push --server`);
  await expect(tokenDialog.getByLabel('上傳命令')).toContainText(token);
  await shot(page, 'token-dialog');
  await tokenDialog.getByRole('button', { name: '我已妥善保存' }).click();
  const row = page.locator('tr', { hasText: SOURCE_NAME });
  await expect(row).toContainText('尚未同步');
  await expect(row).toContainText('啟用中');

  // 第一次推送：新增任務
  const first = await push(
    page.request,
    token,
    pushDoc({ title: TITLE, description: '原說明', priority: 'none', updatedAt: Date.now() - 60 * 60_000 }),
  );
  expect(first.totals.created).toBe(1);
  const task = await findTask(page.request);

  // 中央修改，接著本機也修改（幾乎同時）→ 衝突
  const patched = await page.request.patch(`/api/tasks/${task.id}`, {
    data: { title: `中央標題 ${stamp}`, description: '中央說明' },
  });
  expect(patched.status()).toBe(200);
  const second = await push(
    page.request,
    token,
    pushDoc({ title: `上傳標題 ${stamp}`, description: '上傳說明', priority: 'high', updatedAt: Date.now() }),
  );
  expect(second.totals.conflict).toBe(1);

  await page.reload();
  await expect(row).toContainText('衝突 1');
  await shot(page, 'sources');

  // 待確認衝突
  const conflictsTab = page.getByRole('tab', { name: /待確認衝突/ });
  await expect(conflictsTab).toContainText(/\d+/);
  await conflictsTab.click();
  const item = page
    .locator('tr', { hasText: `中央標題 ${stamp}` })
    .or(page.locator('tr', { hasText: `上傳標題 ${stamp}` }));
  await expect(item.first()).toBeVisible();
  await expect(item.first()).toContainText(SOURCE_NAME);
  await expect(item.first()).toContainText(/差/);
  await shot(page, 'conflicts');
  await item.first().getByRole('button', { name: /比較/ }).click();

  // 並排比較：只列出不同的欄位，逐欄位選擇
  const compare = page.getByRole('region', { name: '並排比較' });
  await expect(compare.getByText('這筆資料兩邊幾乎同時被修改')).toBeVisible();
  await expect(compare.locator('tr[data-field]')).toHaveCount(3);
  await expect(compare.locator('tr[data-field="title"]')).toContainText(`中央標題 ${stamp}`);
  await expect(compare.locator('tr[data-field="title"]')).toContainText(`上傳標題 ${stamp}`);
  await compare.getByLabel('標題：採用上傳').check();
  await compare.getByLabel('優先度：採用上傳').check();
  await expect(compare.getByLabel('描述：保留中央')).toBeChecked();
  await expect(compare.getByText('將採用上傳的 2 個欄位，其餘保留中央')).toBeVisible();
  await shot(page, 'compare');
  await compare.getByRole('button', { name: '套用決定' }).click();
  await expect(page.getByText(/已處理（逐欄位合併）/)).toBeVisible();

  const after = (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as Task;
  expect(after.title).toBe(`上傳標題 ${stamp}`);
  expect(after.description).toBe('中央說明');
  expect(after.priority).toBe('high');

  // 已處理紀錄
  await page.getByRole('button', { name: '已處理紀錄' }).click();
  const done = page.locator('tr', { hasText: `上傳標題 ${stamp}` });
  await expect(done).toContainText('逐欄位合併');
  await expect(done).toContainText(E2E_USERS.manager.displayName);

  // 重送同一份不再產生衝突
  const again = await push(
    page.request,
    token,
    pushDoc({ title: `上傳標題 ${stamp}`, description: '上傳說明', priority: 'high', updatedAt: Date.now() }),
  );
  expect(again.totals.conflict).toBe(0);
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});
