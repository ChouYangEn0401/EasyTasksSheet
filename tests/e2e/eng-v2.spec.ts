import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// 工程追蹤 v2：(A) 自訂狀態、(B) 掃描本機專案、(C) 多台電腦回報的安全機制（空回報攔截、回收區）。
// 截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時，把關鍵畫面存到該資料夾。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const TOKEN = 'e2e-report-token';
const SHOT_DIR = process.env.ENG_SHOT_DIR;
const WIDTH = Number(process.env.ENG_SHOT_WIDTH ?? 1280);

test.use({ viewport: { width: WIDTH, height: 900 } });

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(350); // 等對話框淡入完成
  await page.screenshot({ path: resolve(SHOT_DIR, `${name}-${WIDTH}.png`), animations: 'disabled' });
}

const wtRow = (scope: Page | Locator, text: string) =>
  scope.locator('tr.eng-wt-row').filter({ hasText: text });
const issueRow = (page: Page, title: string) => page.locator('tr.eng-issue-row').filter({ hasText: title });
const okErrors = (errors: string[]) => errors.filter((e) => !e.includes('Failed to load resource'));

test('(A) 成員新增自訂工作樹狀態並套用；新增問題狀態；管理狀態對話框', async ({ page }) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  const branch = `feat/status-${stamp}`;
  const form = page.getByRole('form', { name: '新增 worktree 紀錄' });
  await form.getByLabel('電腦').fill(`E2E-ST-${stamp}`);
  await form.getByLabel('路徑').fill(`C:/e2e/${stamp}/status`);
  await form.getByLabel('分支').fill(branch);
  await form.getByRole('button', { name: '新增紀錄' }).click();
  const row = wtRow(page, branch);
  await expect(row.getByText('使用中')).toBeVisible();

  // 選單有新的內建狀態；底部可新增 / 管理
  await row.getByRole('button', { name: `「${branch}」的狀態` }).click();
  for (const label of ['損毀', '技術債', '舊版保留', '未知']) {
    await expect(page.getByRole('option', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '管理狀態…' })).toBeVisible();
  await shot(page, 'a1-status-menu');
  await page.getByRole('button', { name: '新增狀態…' }).click();
  const add = page.getByRole('dialog', { name: '新增工作樹狀態' });
  const custom = `待驗證${stamp}`;
  await add.getByLabel('狀態名稱').fill(custom);
  await add.getByRole('button', { name: '新增', exact: true }).click();
  await expect(add).toHaveCount(0);
  // 新增後直接套用到這一列
  await expect(row.getByText(custom)).toBeVisible();

  // 管理狀態對話框：內建不可刪除，有使用的自訂狀態只能封存
  await page.getByRole('button', { name: '管理狀態', exact: true }).click();
  const manage = page.getByRole('dialog', { name: '管理工作樹狀態' });
  await expect(manage.getByTestId('eng-status-row')).toHaveCount(10);
  await expect(manage.getByRole('button', { name: '刪除狀態：使用中' })).toHaveCount(0);
  await expect(manage.getByRole('button', { name: `刪除狀態：${custom}` })).toBeDisabled();
  await shot(page, 'a2-status-manage');
  await manage.getByRole('button', { name: '完成' }).click();

  // 問題：成員新增問題狀態並套用
  await page.goto('/eng');
  const title = `E2E 狀態問題 ${stamp}`;
  const issueForm = page.getByRole('form', { name: '新增問題' });
  await issueForm.getByLabel('標題').fill(title);
  await issueForm.getByLabel('標題').press('Enter');
  const irow = issueRow(page, title);
  await expect(irow.getByText('未處理')).toBeVisible();
  await irow.getByRole('button', { name: `「${title}」的狀態` }).click();
  await expect(page.getByRole('option', { name: '卡住' })).toBeVisible();
  await page.getByRole('button', { name: '新增狀態…' }).click();
  const addIssue = page.getByRole('dialog', { name: '新增問題狀態' });
  const issueStatus = `待回覆${stamp}`;
  await addIssue.getByLabel('狀態名稱').fill(issueStatus);
  await addIssue.getByRole('button', { name: '新增', exact: true }).click();
  await expect(irow.getByText(issueStatus)).toBeVisible();

  expect(okErrors(errors)).toEqual([]);
});

test('(B) 掃描本機專案：預覽 → 勾選 → 登記', async ({ page }) => {
  const errors = collectErrors(page);
  // 在允許掃描的資料夾（WORKTREE_SCAN_ROOTS=data/e2e-scan）建立暫存 git repo 與兩個 worktree
  const root = resolve('data/e2e-scan', stamp);
  rmSync(root, { recursive: true, force: true });
  const proj = resolve(root, 'proj');
  mkdirSync(proj, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd, stdio: 'pipe' },
    );
  git(proj, 'init', '-q', '-b', 'main');
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(proj, 'worktree', 'add', '-q', '-b', `feat/scan-a-${stamp}`, resolve(root, 'wt-a'));
  git(proj, 'worktree', 'add', '-q', '-b', `feat/scan-b-${stamp}`, resolve(root, 'wt-b'));

  await loginViaUi(page, E2E_USERS.admin, '/eng?tab=worktrees');
  await page.getByRole('button', { name: '掃描本機專案' }).click();
  const dialog = page.getByRole('dialog', { name: '掃描本機專案' });
  await dialog.getByLabel('專案資料夾').fill(proj);
  await dialog.getByRole('button', { name: '預覽' }).click();
  const preview = dialog.getByTestId('scan-preview');
  await expect(preview).toContainText('新增 2、已存在 0、可能搬動 0');
  await expect(preview.getByText(`feat/scan-a-${stamp}`)).toBeVisible();
  await shot(page, 'b1-scan-preview');
  // 只登記一個：取消勾選 b
  await dialog.getByLabel(`登記 feat/scan-b-${stamp}`).uncheck();
  await dialog.getByRole('button', { name: '登記（1）' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wtRow(page, `feat/scan-a-${stamp}`).getByText('掃描登記')).toBeVisible();
  await expect(wtRow(page, `feat/scan-b-${stamp}`)).toHaveCount(0);

  // 再掃一次：a 為已登記（不可勾選）
  await page.getByRole('button', { name: '掃描本機專案' }).click();
  await dialog.getByRole('button', { name: '預覽' }).click();
  await expect(dialog.getByTestId('scan-preview')).toContainText('新增 1、已存在 1');
  await expect(dialog.getByLabel(`登記 feat/scan-a-${stamp}`)).toBeDisabled();
  // 範圍外的資料夾被拒
  await dialog.getByLabel('專案資料夾').fill(resolve('.'));
  await dialog.getByRole('button', { name: '預覽' }).click();
  await expect(dialog.getByText(/不在允許掃描的範圍內/)).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();

  // 一般成員看不到掃描按鈕
  await page.context().clearCookies();
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  await expect(page.getByRole('button', { name: '回收區', exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '掃描本機專案' })).toHaveCount(0);

  expect(okErrors(errors)).toEqual([]);
});

test('(C) 回報空清單被攔住、舊資料仍在；不同電腦依識別碼分組', async ({ page }) => {
  const errors = collectErrors(page);
  const machine = `E2E-RPT-${stamp}`;
  const machineId = `e2e-${stamp}-aaaa`;
  const post = (worktrees: object[]) =>
    page.request.post('/api/eng/worktrees/report', {
      headers: { 'x-report-token': TOKEN },
      data: { machine, machineId, repo: 'e2e-repo', worktrees },
    });
  const wts = [1, 2, 3].map((i) => ({
    path: `D:/e2e/${stamp}/wt-${i}`,
    branch: `feat/rpt-${i}-${stamp}`,
    headSha: 'abcdef1',
  }));
  expect((await post(wts)).status()).toBe(200);
  const held = await (await post([])).json();
  expect(held).toMatchObject({ held: true, reason: 'empty', previous: 3 });

  // 另一台很久沒回報的電腦（模擬 3 天前）
  const db = new DatabaseSync(resolve('data/e2e.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const old = Date.now() - 3 * 86_400_000;
    db.prepare(
      'INSERT INTO worktree_report_sources (machine_key, machine_id, machine, repo, last_report_at, last_applied_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`id:e2e-old-${stamp}`, `e2e-old-${stamp}`, `E2E-OLD-${stamp}`, 'e2e-repo', old, old);
    db.prepare(
      'INSERT INTO worktree_reports (machine, machine_id, repo, path, branch, head_sha, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `E2E-OLD-${stamp}`,
      `e2e-old-${stamp}`,
      'e2e-repo',
      `E:/old/${stamp}`,
      `feat/old-${stamp}`,
      'abcdef2',
      old,
    );
  } finally {
    db.close();
  }

  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  const section = page.getByRole('region', { name: `電腦 ${machine}` });
  await expect(section.getByText('可疑回報待確認')).toBeVisible();
  await expect(section.getByTestId('pending-report')).toContainText(
    '最新回報為空清單（先前 3 筆），已保留舊資料',
  );
  // 舊資料仍在（3 筆未登記）
  await expect(section.locator('tr.eng-wt-row')).toHaveCount(3);
  const oldSection = page.getByRole('region', { name: `電腦 E2E-OLD-${stamp}` });
  await expect(oldSection.getByText(/未回報（最後看到 3 天前）/)).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'c1-machines-suspicious');

  // 保留舊資料（忽略這次回報）
  await section.getByRole('button', { name: '保留舊資料' }).click();
  await expect(section.getByTestId('pending-report')).toHaveCount(0);
  await expect(section.locator('tr.eng-wt-row')).toHaveCount(3);

  expect(okErrors(errors)).toEqual([]);
});

test('(C) 刪除 → 回收區 → 還原', async ({ page }) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  const branch = `feat/trash-${stamp}`;
  const form = page.getByRole('form', { name: '新增 worktree 紀錄' });
  await form.getByLabel('電腦').fill(`E2E-TR-${stamp}`);
  await form.getByLabel('路徑').fill(`C:/e2e/${stamp}/trash`);
  await form.getByLabel('分支').fill(branch);
  await form.getByRole('button', { name: '新增紀錄' }).click();
  const row = wtRow(page, branch);
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: `「${branch}」的操作` }).click();
  await page.getByRole('menuitem', { name: '移到回收區' }).click();
  await page
    .getByRole('alertdialog', { name: '移到回收區？' })
    .getByRole('button', { name: '移到回收區' })
    .click();
  await expect(row).toHaveCount(0);

  await page.getByRole('button', { name: /回收區（\d+）/ }).click();
  const trash = page.getByRole('dialog', { name: '回收區' });
  const item = trash.locator('.eng-trash-item').filter({ hasText: branch });
  await expect(item).toBeVisible();
  // 成員看不到「清空回收區」（需管理者）
  await expect(trash.getByRole('button', { name: '清空回收區' })).toHaveCount(0);
  await shot(page, 'c2-trash');
  await item.getByRole('button', { name: '還原' }).click();
  await expect(item).toHaveCount(0);
  await trash.getByRole('button', { name: '完成' }).click();
  await expect(wtRow(page, branch)).toBeVisible();

  expect(okErrors(errors)).toEqual([]);
});
