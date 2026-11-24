import { expect, test, type Page } from '@playwright/test';
import { createGitFixture } from '../../src/server/features/eng/gitFixture.ts';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// T6 工程追蹤：管理 repo → issue 未設定 token 提示 → worktree 偵測（暫存 git repo）→ 篩選 → 登記 / 編輯 / 刪除安排
test.describe.configure({ mode: 'serial' });

const fx = createGitFixture();
const REPO_NAME = `e2e-repo-${Date.now()}`;

test.beforeAll(() => {
  fx.scenario(Date.now());
});
test.afterAll(() => fx.cleanup());

const row = (page: Page, branch: string) =>
  page.locator('tr.eng-wt-row').filter({ has: page.getByText(branch, { exact: true }) });

test('管理員：新增 repo、查看 issue 提示與 worktree 狀態，登記 / 編輯 / 刪除安排', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.admin, '/eng');

  // 沒有 repo：空狀態 + 管理 repo
  await expect(page.getByText('尚未登記任何 repo')).toBeVisible();
  await page.getByRole('button', { name: '管理 repo' }).click();
  const manage = page.getByRole('dialog', { name: '管理 repo' });
  await manage.getByLabel('名稱').fill(REPO_NAME);
  await manage.getByLabel('本機路徑').fill(fx.repo);
  await manage.getByLabel('遠端').fill('acme/demo');
  await manage.getByRole('button', { name: '儲存' }).click();
  await expect(manage.getByText(REPO_NAME)).toBeVisible();
  await expect(manage.locator('.eng-repo-item time')).toBeVisible();
  await manage.getByRole('button', { name: '關閉' }).click();

  // Issues 分頁（E2E 未設定 token）
  await expect(page.getByRole('link', { name: /Issues/ })).toHaveAttribute('aria-current', 'page');
  if (!process.env.GITHUB_TOKEN) {
    await expect(page.getByText('尚未設定 issue 來源')).toBeVisible();
    await expect(page.getByRole('button', { name: '重試' })).toHaveCount(0);
  }

  // Worktrees 分頁：URL 驅動
  await page.getByRole('link', { name: /Worktrees/ }).click();
  await expect(page).toHaveURL(/tab=worktrees/);
  await expect(row(page, 'tmp/spike')).toBeVisible();
  // 尚無安排：全部為未登記（遺失的 worktree 也列出）
  await expect(row(page, 'feat/ok').getByText('未登記')).toBeVisible();
  await expect(row(page, 'feat/gone').getByText('遺失')).toBeVisible();
  await expect(row(page, 'feat/dirty').getByText('未提交變更')).toBeVisible();
  await expect(row(page, 'feat/stale').getByText('久未更新')).toBeVisible();
  // 每列都有更新時間
  const rowCount = await page.locator('tr.eng-wt-row').count();
  await expect(page.locator('tr.eng-wt-row td:nth-last-child(2) time')).toHaveCount(rowCount);

  // 登記 feat/merged → 已合併未清理
  await row(page, 'feat/merged').getByRole('button', { name: '登記' }).click();
  let dialog = page.getByRole('dialog', { name: '新增 worktree 安排' });
  await expect(dialog.getByLabel('分支')).toHaveValue('feat/merged');
  await dialog.getByLabel('用途').fill('合併後待清理');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'feat/merged').getByText('已合併未清理')).toBeVisible();
  await expect(row(page, 'feat/merged').getByText('已併入 main')).toBeVisible();

  // 新增一個不存在的安排 → 遺失；路徑重複時顯示欄位錯誤
  await page.getByRole('button', { name: '新增安排' }).first().click();
  dialog = page.getByRole('dialog', { name: '新增 worktree 安排' });
  await dialog.getByLabel('分支').fill('feat/never');
  await dialog.getByLabel('路徑').fill('../wt-merged');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog.getByText('此路徑已有安排')).toBeVisible();
  await dialog.getByLabel('路徑').fill('../wt-never');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'feat/never').getByText('找不到此 worktree')).toBeVisible();

  // 篩選 chip：遺失（URL 保留）
  await page.getByRole('button', { name: /^遺失/ }).click();
  await expect(page).toHaveURL(/wt=missing/);
  await expect(row(page, 'feat/never')).toBeVisible();
  await expect(row(page, 'tmp/spike')).toHaveCount(0);
  await page.reload();
  await expect(row(page, 'feat/never')).toBeVisible();
  await expect(row(page, 'tmp/spike')).toHaveCount(0);
  await page.getByRole('button', { name: /^全部/ }).click();
  await expect(row(page, 'tmp/spike')).toBeVisible();

  // 編輯安排
  await row(page, 'feat/never')
    .getByRole('button', { name: /的動作$/ })
    .click();
  await page.getByRole('menuitem', { name: '編輯安排' }).click();
  dialog = page.getByRole('dialog', { name: '編輯 worktree 安排' });
  await dialog.getByLabel('分支').fill('feat/never-2');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'feat/never-2')).toBeVisible();

  // 刪除安排
  await row(page, 'feat/never-2')
    .getByRole('button', { name: /的動作$/ })
    .click();
  await page.getByRole('menuitem', { name: '刪除安排' }).click();
  const confirm = page.getByRole('alertdialog', { name: '刪除此安排？' });
  await confirm.getByRole('button', { name: '刪除' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, 'feat/never-2')).toHaveCount(0);

  // R：重新偵測
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('r');
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: /已更新，共 \d+ 筆/ })).toBeAttached();

  // 預期中的 409（路徑重複）會在 console 留下資源載入失敗訊息，不算錯誤
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('一般成員：看得到 repo 與 worktree，但沒有管理 repo 入口', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  await expect(row(page, 'tmp/spike')).toBeVisible();
  await expect(page.getByRole('button', { name: '管理 repo' })).toHaveCount(0);
  const res = await page.request.post('/api/eng/repos', {
    headers: { 'content-type': 'application/json', origin: new URL(page.url()).origin },
    data: JSON.stringify({ name: 'x' }),
  });
  expect(res.status()).toBe(403);
});
