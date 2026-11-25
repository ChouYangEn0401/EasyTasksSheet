import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// feat/overview-optout：帳號可「不列入總覽統計」。root（admin）預設不列入；
// 只操作本 spec 自建的帳號，不改動 admin / member / manager / peer 的狀態。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const USERNAME = `oo-${stamp}`;
const NAME = `總覽測試 ${stamp}`;
const shots = process.env.SHOTS_DIR;

type U = { id: number; username: string; inOverview: boolean };

async function users(page: Page): Promise<U[]> {
  const res = await page.request.get('/api/users');
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as U[];
}

/** 設了 SHOTS_DIR 時，以 1280 / 768 各截一張（驗收用） */
async function shoot(page: Page, name: string) {
  if (!shots) return;
  const orig = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/${name}-${width}.png` });
  }
  await page.setViewportSize(orig);
}

test('root 不出現在總覽；成員管理可關閉 / 開啟「列入總覽統計」', async ({ page }) => {
  test.setTimeout(90_000);
  await loginViaUi(page, E2E_USERS.admin, '/admin/users');

  // 新增成員（預設列入）：對話框內開關預設勾選；切到 root 角色預設取消
  await page.getByRole('button', { name: '新增成員' }).click();
  const create = page.getByRole('dialog', { name: '新增成員' });
  const toggle = create.getByLabel('列入總覽統計');
  await expect(toggle).toBeChecked();
  await expect(create.getByText('任務仍可指派給他。')).toBeVisible();
  await create.getByLabel('帳號').fill(USERNAME);
  await create.getByLabel('顯示名稱').fill(NAME);
  await create.getByRole('button', { name: '建立' }).click();
  const created = page.getByRole('dialog', { name: `已建立成員「${NAME}」` });
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: '完成' }).click();

  const list = await users(page);
  const admin = list.find((u) => u.username === E2E_USERS.admin.username)!;
  const mine = list.find((u) => u.username === USERNAME)!;
  expect(admin.inOverview).toBe(false);
  expect(mine.inOverview).toBe(true);

  // 全站完全沒有任務時，總覽會把「目前無任務」的成員收合成一組（不顯示個別卡片）；
  // 先指派一筆任務給新成員，讓卡片版面不依賴其他 spec 殘留的資料
  const seed = await page.request.post('/api/tasks', {
    data: { title: `指派給新成員 ${stamp}`, assigneeId: mine.id },
  });
  expect(seed.ok()).toBeTruthy();

  // 總覽：root 無卡片、新成員有卡片
  await page.goto('/');
  await expect(page.getByTestId(`member-card-${mine.id}`)).toBeVisible();
  await expect(page.getByTestId(`member-card-${admin.id}`)).toHaveCount(0);

  // 成員管理：關閉該成員
  await page.goto('/admin/users');
  const row = page.locator(`tbody tr[data-username="${USERNAME}"]`);
  await expect(row.getByText('不列入總覽')).toHaveCount(0);
  const openEdit = async () => {
    await page.getByRole('button', { name: `${NAME} 的操作` }).click();
    await page.getByRole('menuitem', { name: '編輯' }).click();
    return page.getByRole('dialog', { name: '編輯成員' });
  };
  let edit = await openEdit();
  await edit.getByLabel('列入總覽統計').uncheck();
  await shoot(page, 'admin-users-dialog');
  await edit.getByRole('button', { name: '儲存' }).click();
  await expect(edit).toBeHidden();
  await expect(row.getByText('不列入總覽')).toBeVisible();
  await shoot(page, 'admin-users');

  await page.goto('/');
  await expect(page.getByTestId('stat-idle')).toBeVisible();
  await expect(page.getByTestId(`member-card-${mine.id}`)).toHaveCount(0);
  await shoot(page, 'overview');
  // 任務仍可指派給他：任務 API 不受影響
  const res = await page.request.post('/api/tasks', {
    headers: { 'content-type': 'application/json', origin: new URL(page.url()).origin },
    data: JSON.stringify({ title: `指派給不列入者 ${stamp}`, assigneeId: mine.id }),
  });
  expect(res.ok()).toBeTruthy();

  // 再開啟 → 卡片回來
  await page.goto('/admin/users');
  edit = await openEdit();
  await edit.getByLabel('列入總覽統計').check();
  await edit.getByRole('button', { name: '儲存' }).click();
  await expect(edit).toBeHidden();
  await expect(row.getByText('不列入總覽')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId(`member-card-${mine.id}`)).toBeVisible();

  // 還原：停用測試帳號，避免影響他處
  await page.goto('/admin/users');
  await page.getByRole('button', { name: `${NAME} 的操作` }).click();
  await page.getByRole('menuitem', { name: '停用' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '停用' }).click();
  await expect(row.getByText('已停用')).toBeVisible();
});
