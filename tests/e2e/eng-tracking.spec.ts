import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 工程追蹤簡化版（手動輸入優先）：問題的新增 / 改狀態 / 結案；worktree 紀錄的新增 / 登記 / 刪除；
// 各電腦回報快照的顯示與「未登記」「可能遺失」提示。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const ISSUE = `E2E 問題 ${stamp}`;
const ISSUE_RENAMED = `E2E 問題改名 ${stamp}`;
const PROJECT = `e2e-proj-${stamp}`;
const MACHINE = `E2E-PC-${stamp}`;
const WT = {
  kept: { path: `C:/e2e/${stamp}/wt-kept`, branch: `feat/kept-${stamp}` },
  gone: { path: `C:/e2e/${stamp}/wt-gone`, branch: `feat/gone-${stamp}` },
  spike: { path: `C:/e2e/${stamp}/wt-spike`, branch: `tmp/spike-${stamp}` },
};

/** 模擬某台電腦已回報（E2E 未設定 WORKTREE_REPORT_TOKEN，直接寫入 E2E 專用 DB） */
function seedReport() {
  const db = new DatabaseSync(resolve('data/e2e.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const insert = db.prepare(
      'INSERT INTO worktree_reports (machine, repo, path, branch, head_sha, is_dirty, ahead, behind, is_merged, reported_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const t = Date.now();
    insert.run(MACHINE, 'e2e-repo', WT.kept.path, WT.kept.branch, 'abcdef1', 1, 2, 0, 0, t);
    insert.run(MACHINE, 'e2e-repo', WT.spike.path, WT.spike.branch, 'abcdef2', 0, 0, 3, 0, t);
  } finally {
    db.close();
  }
}

const tab = (page: Page, name: RegExp) =>
  page.getByRole('navigation', { name: '工程追蹤' }).getByRole('link', { name });
const issueRow = (page: Page, title: string) => page.locator('tr.eng-issue-row').filter({ hasText: title });
const wtRow = (scope: Page | Locator, branch: string) =>
  scope.locator('tr.eng-wt-row').filter({ hasText: branch });

async function pickOption(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole('option', { name: option }).click();
}

test('問題：手動新增 → 改狀態 → 編輯 → 結案 → 顯示已結案', async ({ page }) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng');
  await expect(tab(page, /問題/)).toHaveAttribute('aria-current', 'page');

  // 新增表單在最上面：填標題與專案，Enter 送出
  const form = page.getByRole('form', { name: '新增問題' });
  await form.getByLabel('專案 / Repo').fill(PROJECT);
  await form.getByLabel('標題').fill(ISSUE);
  await form.getByLabel('標題').press('Enter');
  const row = issueRow(page, ISSUE);
  await expect(row).toBeVisible();
  await expect(row.getByText(PROJECT)).toBeVisible();
  await expect(row.getByText('未處理')).toBeVisible();
  await expect(row.locator('time')).toHaveCount(1);
  // 送出後標題清空、專案保留，方便連續登錄
  await expect(form.getByLabel('標題')).toHaveValue('');
  await expect(form.getByLabel('專案 / Repo')).toHaveValue(PROJECT);

  // 列上直接改狀態
  await pickOption(page, row.getByRole('button', { name: `「${ISSUE}」的狀態` }), '處理中');
  await expect(row.getByText('處理中')).toBeVisible();

  // 編輯（對話框）
  await row.getByRole('button', { name: `「${ISSUE}」的操作` }).click();
  await page.getByRole('menuitem', { name: '編輯' }).click();
  const dialog = page.getByRole('dialog', { name: '編輯問題' });
  await dialog.getByLabel('標題').fill(ISSUE_RENAMED);
  await dialog.getByLabel('連結').fill('https://example.com/issue/1');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  const renamed = issueRow(page, ISSUE_RENAMED);
  await expect(renamed.getByRole('link', { name: `開啟「${ISSUE_RENAMED}」的連結` })).toHaveAttribute(
    'href',
    'https://example.com/issue/1',
  );

  // 結案：預設清單隱藏，勾選「顯示已結案」後出現
  await renamed.getByRole('button', { name: `「${ISSUE_RENAMED}」的操作` }).click();
  await page.getByRole('menuitem', { name: '結案' }).click();
  await expect(renamed).toHaveCount(0);
  await page.getByLabel(/顯示已結案/).check();
  await expect(renamed.getByText('已結案')).toBeVisible();

  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('GitHub 連動（未設定 token）：不顯示 GitHub 按鈕；貼 GitHub issue 網址會解析出編號', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng');
  const enabled = ((await (await page.request.get('/api/eng/issues')).json()) as { githubEnabled: boolean })
    .githubEnabled;
  test.skip(enabled, 'E2E 伺服器設定了 GITHUB_TOKEN');

  await expect(page.getByRole('button', { name: /GitHub/ })).toHaveCount(0);

  const title = `E2E GitHub ${stamp}`;
  const form = page.getByRole('form', { name: '新增問題' });
  await form.getByLabel('標題').fill(title);
  await form.getByLabel('連結').fill('https://github.com/Acme/Widgets/issues/42');
  await form.getByRole('button', { name: '新增問題' }).click();
  const row = issueRow(page, title);
  await expect(row.getByText('#42')).toBeVisible();
  // 一般網址不顯示編號
  await row.getByRole('button', { name: `「${title}」的操作` }).click();
  await expect(page.getByRole('menuitem', { name: '編輯' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /GitHub/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '編輯' }).click();
  const dialog = page.getByRole('dialog', { name: '編輯問題' });
  await dialog.getByLabel('連結').fill('https://example.com/issue/42');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText('#42')).toHaveCount(0);

  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('Worktree：手動新增紀錄、回報快照依電腦分組、未登記與可能遺失提示', async ({ page }) => {
  const errors = collectErrors(page);
  // 未設定回報 token：回報端點一律 403（不需登入）
  if (!process.env.WORKTREE_REPORT_TOKEN) {
    const res = await page.request.post('/api/eng/worktrees/report', {
      headers: { 'x-report-token': 'whatever' },
      data: { machine: MACHINE, worktrees: [] },
    });
    expect(res.status()).toBe(403);
  }

  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  await expect(tab(page, /工作樹/)).toHaveAttribute('aria-current', 'page');

  // 手動新增兩筆紀錄（電腦名稱會記住，第二筆不用再填）
  const form = page.getByRole('form', { name: '新增 worktree 紀錄' });
  await form.getByLabel('電腦').fill(MACHINE);
  for (const wt of [WT.kept, WT.gone]) {
    await form.getByLabel('路徑').fill(wt.path);
    await form.getByLabel('分支').fill(wt.branch);
    await form.getByRole('button', { name: '新增紀錄' }).click();
    await expect(form.getByLabel('路徑')).toHaveValue('');
  }
  await expect(form.getByLabel('電腦')).toHaveValue(MACHINE);

  const section = page.getByRole('region', { name: `電腦 ${MACHINE}` });
  await expect(section.getByText('尚未回報（僅手動紀錄）')).toBeVisible();
  await expect(wtRow(section, WT.kept.branch).getByText('使用中')).toBeVisible();
  // 同電腦同路徑不可重複
  await form.getByLabel('路徑').fill(WT.kept.path.toUpperCase());
  await form.getByRole('button', { name: '新增紀錄' }).click();
  await expect(form.getByText('此電腦的這個路徑已有紀錄')).toBeVisible();
  await form.getByLabel('路徑').fill('');

  // 該電腦回報：kept（有紀錄）與 spike（未登記）；gone 不在回報中 → 可能遺失
  seedReport();
  await page.reload();
  await expect(section.getByText(/回報於/).first()).toBeVisible();
  await expect(wtRow(section, WT.kept.branch).getByText('未提交變更 · ↑2 ↓0')).toBeVisible();
  await expect(wtRow(section, WT.gone.branch).getByText('可能遺失')).toBeVisible();
  const spike = wtRow(section, WT.spike.branch);
  await expect(spike.getByText('未登記')).toBeVisible();
  await expect(tab(page, /工作樹/).getByLabel('2 個提示')).toBeVisible();
  // 每列都有更新時間
  const rows = await section.locator('tr.eng-wt-row').count();
  expect(rows).toBe(3);
  await expect(section.locator('tr.eng-wt-row time')).toHaveCount(rows);

  // 一鍵登記 → 不再是未登記
  await spike.getByRole('button', { name: '登記' }).click();
  await expect(spike.getByText('未登記')).toHaveCount(0);
  await expect(spike.getByText('使用中')).toBeVisible();

  // 手動狀態改為「已遺失」→ 不再提示可能遺失
  const gone = wtRow(section, WT.gone.branch);
  await pickOption(page, gone.getByRole('button', { name: `「${WT.gone.branch}」的狀態` }), '已遺失');
  await expect(gone.getByText('已遺失')).toBeVisible();
  await expect(gone.getByText('可能遺失')).toHaveCount(0);

  // 編輯備註、刪除紀錄
  await gone.getByRole('button', { name: `「${WT.gone.branch}」的操作` }).click();
  await page.getByRole('menuitem', { name: '編輯' }).click();
  const dialog = page.getByRole('dialog', { name: '編輯 worktree 紀錄' });
  await dialog.getByLabel('備註').fill('硬碟重灌後消失');
  await dialog.getByRole('button', { name: '儲存' }).click();
  await expect(gone.getByText('硬碟重灌後消失')).toBeVisible();

  await gone.getByRole('button', { name: `「${WT.gone.branch}」的操作` }).click();
  await page.getByRole('menuitem', { name: '刪除' }).click();
  const confirm = page.getByRole('alertdialog', { name: '刪除此紀錄？' });
  await confirm.getByRole('button', { name: '刪除' }).click();
  await expect(gone).toHaveCount(0);

  // 預期中的 409（路徑重複）會在 console 留下資源載入失敗訊息，不算錯誤
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});
