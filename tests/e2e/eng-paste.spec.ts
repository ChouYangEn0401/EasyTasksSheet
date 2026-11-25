import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 貼上 git worktree list 輸出 → 預覽 → 勾選 → 登記。截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時存檔。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const SHOT_DIR = process.env.ENG_SHOT_DIR;
const WIDTH = Number(process.env.ENG_SHOT_WIDTH ?? 1280);
test.use({ viewport: { width: WIDTH, height: 900 } });

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(SHOT_DIR, `${name}-${WIDTH}.png`), animations: 'disabled' });
}

const SAMPLE = `C:/Users/someone/Desktop/local專案/Main-Repo                                      80a0d97a [feat/extrepo-phase2]
C:/Users/someone/AppData/Local/Temp/claude/abc123/scratchpad/master_base          2e213717 (detached HEAD)
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a238ac466903f90b4  33b6a929 [worktree-agent-a238ac466903f90b4] locked
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a458f9f92f1744e0c  ff16b462 [worktree-agent-a458f9f92f1744e0c]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneA                           16687b8d [hotfix/gitea-ssl-fallback]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneB                           241e5bc4 [feat/db_redesign]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC1                          30145fda [feat/aca-rebuild-r7-fix-c1]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC2                          30145fda [feat/aca-rebuild-ac-redo-support]
`;

test('貼上 git worktree list：預覽 → 預設勾選 → 登記 → 電腦篩選 → 再貼全為已存在', async ({ page }) => {
  const errors = collectErrors(page);
  const machine = `E2E-PASTE-${stamp}`;
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  await shot(page, 'p1-before');

  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  const dialog = page.getByRole('dialog', { name: '貼上 git worktree list' });
  await expect(dialog.getByText('這裡只解析文字')).toBeVisible();
  await dialog.getByLabel('電腦名稱').fill(machine);
  await dialog.getByTestId('paste-text').fill(SAMPLE);

  const preview = dialog.getByTestId('paste-preview');
  await expect(preview.getByTestId('paste-summary')).toContainText('新增 8、已存在 0、可能搬動 0');
  await expect(dialog.getByLabel('專案 / Repo 名稱')).toHaveValue('Main-Repo');
  // 暫時性 3 筆（scratchpad、兩個 .claude/worktrees）預設不勾；其餘 5 筆勾選
  await expect(preview.getByText('暫時性', { exact: true })).toHaveCount(3);
  await expect(preview.getByText('鎖定', { exact: true })).toHaveCount(1);
  await expect(preview.getByText('分離 HEAD', { exact: true })).toHaveCount(1);
  await expect(preview.getByTestId('paste-count')).toHaveText('已選 5 / 8');
  await expect(dialog.getByLabel('登記 worktree-agent-a238ac466903f90b4')).not.toBeChecked();
  await expect(dialog.getByLabel('登記 feat/db_redesign')).toBeChecked();
  // 批次操作
  await dialog.getByRole('button', { name: '全選' }).click();
  await expect(preview.getByTestId('paste-count')).toHaveText('已選 8 / 8');
  await dialog.getByRole('button', { name: '全不選' }).click();
  await expect(preview.getByTestId('paste-count')).toHaveText('已選 0 / 8');
  await expect(dialog.getByRole('button', { name: '登記 0 筆' })).toBeDisabled();
  await dialog.getByRole('button', { name: '只選非暫時性' }).click();
  await expect(preview.getByTestId('paste-count')).toHaveText('已選 5 / 8');
  await shot(page, 'p2-preview');

  await dialog.getByRole('button', { name: '登記 5 筆' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已登記 5 筆、略過 0 筆')).toBeVisible();

  // 清單出現，且自動套用電腦篩選（只剩這台電腦）
  const section = page.getByRole('region', { name: `電腦 ${machine}` });
  await expect(section.locator('tr.eng-wt-row').filter({ hasText: 'feat/db_redesign' })).toBeVisible();
  await expect(section.locator('tr.eng-wt-row').filter({ hasText: '貼上登記' })).toHaveCount(5);
  await expect(page.getByRole('region', { name: /^電腦 /, exact: false })).toHaveCount(1);
  await shot(page, 'p3-after');
  // 篩選可切回全部
  await page.getByRole('button', { name: '依電腦篩選' }).click();
  await page.getByRole('option', { name: '全部電腦' }).click();
  await expect(section).toBeVisible();

  // 再貼一次：全部已存在（冪等）；暫時性的 3 筆仍是新增
  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  await dialog.getByTestId('paste-text').fill(SAMPLE);
  await expect(dialog.getByLabel('電腦名稱')).toHaveValue(machine); // 記住上次輸入
  await expect(preview.getByTestId('paste-summary')).toContainText('新增 3、已存在 5');
  await expect(dialog.getByRole('button', { name: '登記 0 筆' })).toBeDisabled();
  await expect(dialog.getByLabel('登記 feat/db_redesign')).toBeDisabled();
  // 手動勾選暫時性 → 登記 → Ctrl+Enter
  await dialog.getByLabel('登記 worktree-agent-a238ac466903f90b4').check();
  await dialog.getByTestId('paste-text').press('Control+Enter');
  await expect(page.getByText('已登記 1 筆、略過 0 筆')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // 第三次：全部「已存在」，Esc 關閉
  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  await dialog.getByTestId('paste-text').fill(SAMPLE);
  await expect(preview.getByTestId('paste-summary')).toContainText('新增 2、已存在 6');
  await dialog.getByLabel('登記 worktree-agent-a458f9f92f1744e0c').check();
  await dialog.getByRole('button', { name: '全選' }).click();
  await dialog.getByRole('button', { name: '登記 2 筆' }).click();
  await expect(page.getByText('已登記 2 筆、略過 0 筆')).toBeVisible();
  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  await dialog.getByTestId('paste-text').fill(SAMPLE);
  await expect(preview.getByTestId('paste-summary')).toContainText('新增 0、已存在 8');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('貼上：無法辨識的行折疊顯示；porcelain 與提示字元行', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');
  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  const dialog = page.getByRole('dialog', { name: '貼上 git worktree list' });
  await dialog.getByLabel('電腦名稱').fill(`E2E-PASTE2-${stamp}`);
  await dialog
    .getByTestId('paste-text')
    .fill(
      [
        'C:\\Users\\x>git worktree list',
        'worktree C:/Users/王小明/My Projects/Repo A',
        'HEAD 80a0d97a1111111111111111111111111111aaaa',
        'branch refs/heads/main',
        '',
        'worktree C:/tmp/wt',
        'HEAD 2e213717aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
        'this is not a worktree line',
      ].join('\n'),
    );
  const preview = dialog.getByTestId('paste-preview');
  await expect(preview.getByTestId('paste-summary')).toContainText('新增 2');
  await expect(dialog.getByLabel('專案 / Repo 名稱')).toHaveValue('Repo A');
  await expect(preview.getByText('可清理', { exact: true })).toBeVisible();
  const unparsed = dialog.getByTestId('paste-unparsed');
  await expect(unparsed).toHaveText('有 1 行無法辨識');
  await unparsed.click();
  await expect(preview.getByText('this is not a worktree line')).toBeVisible();
  // 輸入不是 worktree 輸出 → 空清單提示
  await dialog.getByTestId('paste-text').fill('hello world');
  await expect(dialog.getByText('沒有辨識到任何 worktree。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '登記 0 筆' })).toBeDisabled();
});
