import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 工程追蹤「工作樹」每人一份：檢視切換（?user=<id|all>）、我自己只看自己的紀錄、
// 新增預設負責人為自己、檢視他人為唯讀、全部成員依成員分組（含未指派）、重整保留。
// 截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時存檔。
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

const MACHINE = `E2E-PV-${stamp}`;
const BR = {
  mine: `feat/pv-mine-${stamp}`,
  admin: `feat/pv-admin-${stamp}`,
  none: `feat/pv-none-${stamp}`,
};
const json = { 'Content-Type': 'application/json' };
const wtRow = (page: Page, branch: string) => page.locator('tr.eng-wt-row').filter({ hasText: branch });
const card = (page: Page, name: string) => page.getByRole('region', { name: `成員 ${name}`, exact: true });

test('工作樹每人一份：我自己 → 新增預設自己 → 他人唯讀 → 全部成員含未指派 → 重整保留', async ({ page }) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng?tab=worktrees');

  // 準備資料：一筆負責人是管理員、一筆未指派（API 不帶 ownerId）
  const users = (await (await page.request.get('/api/users')).json()) as {
    id: number;
    displayName: string;
  }[];
  const adminId = users.find((u) => u.displayName === E2E_USERS.admin.displayName)!.id;
  const post = (data: object) => page.request.post('/api/eng/worktree-records', { headers: json, data });
  expect(
    (
      await post({ machine: MACHINE, path: `C:/e2e/${stamp}/pv-admin`, branch: BR.admin, ownerId: adminId })
    ).status(),
  ).toBe(201);
  expect((await post({ machine: MACHINE, path: `C:/e2e/${stamp}/pv-none`, branch: BR.none })).status()).toBe(
    201,
  );
  await page.reload();

  // 我自己：沒有我的紀錄時不會看到別人的；頂部提示未指派筆數並連到「全部成員」
  await expect(page.getByRole('button', { name: '檢視成員的工作樹' })).toContainText('我自己');
  await expect(wtRow(page, BR.admin)).toHaveCount(0);
  await expect(wtRow(page, BR.none)).toHaveCount(0);
  await expect(page.getByTestId('unassigned-note')).toContainText(/有 \d+ 筆未指派的工作樹/);

  // 新增表單的負責人預設為目前登入者
  const form = page.getByRole('form', { name: '新增 worktree 紀錄' });
  await expect(form.getByRole('button', { name: '負責人' })).toContainText(E2E_USERS.member.displayName);
  await form.getByLabel('電腦').fill(MACHINE);
  await form.getByLabel('路徑').fill(`C:/e2e/${stamp}/pv-mine`);
  await form.getByLabel('分支').fill(BR.mine);
  await form.getByRole('button', { name: '新增紀錄' }).click();
  const mine = card(page, '我自己');
  await expect(mine.locator('tr.eng-wt-row').filter({ hasText: BR.mine })).toBeVisible();
  // 電腦是第二層小標題
  await expect(mine.getByRole('region', { name: `電腦 ${MACHINE}` })).toBeVisible();
  await expect(mine.getByTestId('owner-count')).toContainText('筆');
  await expect(page.getByTestId('scope-total')).toContainText('共');
  await shot(page, 'pv1-self');

  // 貼上 / 掃描對話框的負責人也預設為自己
  await page.getByRole('button', { name: '貼上 git worktree list' }).click();
  const paste = page.getByRole('dialog', { name: '貼上 git worktree list' });
  await expect(paste.getByRole('button', { name: '登記的負責人' })).toContainText(
    E2E_USERS.member.displayName,
  );
  await paste.getByRole('button', { name: '取消' }).click();

  // 切換到管理員：唯讀（沒有新增表單、狀態下拉、操作選單、貼上 / 掃描按鈕）
  await page.getByRole('button', { name: '檢視成員的工作樹' }).click();
  await page.getByRole('option', { name: E2E_USERS.admin.displayName }).click();
  await expect(page).toHaveURL(new RegExp(`user=${adminId}`));
  await expect(page.getByTestId('readonly-note')).toHaveText(
    `正在檢視 ${E2E_USERS.admin.displayName} 的工作樹（唯讀）`,
  );
  await expect(page.getByRole('form', { name: '新增 worktree 紀錄' })).toHaveCount(0);
  const adminRow = wtRow(page, BR.admin);
  await expect(adminRow).toBeVisible();
  await expect(adminRow.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '貼上 git worktree list' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '掃描本機專案' })).toHaveCount(0);
  await expect(wtRow(page, BR.mine)).toHaveCount(0);
  await shot(page, 'pv2-readonly');

  // 全部成員：依成員分組；我自己在前、未指派在最後；可摺疊
  await page.getByRole('button', { name: '檢視成員的工作樹' }).click();
  await page.getByRole('option', { name: '全部成員' }).click();
  await expect(page).toHaveURL(/user=all/);
  const cards = page.locator('section.eng-owner-card');
  await expect(card(page, '我自己')).toBeVisible();
  await expect(card(page, E2E_USERS.admin.displayName)).toBeVisible();
  await expect(card(page, '未指派')).toBeVisible();
  await expect(cards.first()).toHaveAttribute('aria-label', '成員 我自己');
  await expect(cards.last()).toHaveAttribute('aria-label', '成員 未指派');
  await expect(card(page, '未指派').locator('tr.eng-wt-row').filter({ hasText: BR.none })).toBeVisible();
  await expect(
    card(page, E2E_USERS.admin.displayName).locator('tr.eng-wt-row').filter({ hasText: BR.admin }),
  ).toBeVisible();
  await shot(page, 'pv3-all');
  const toggle = card(page, E2E_USERS.admin.displayName).locator('button.eng-owner-toggle');
  await toggle.click();
  await expect(wtRow(page, BR.admin)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(wtRow(page, BR.admin)).toBeVisible();

  // 重整後 ?user= 保留；回到我自己時參數消失
  await page.reload();
  await expect(page).toHaveURL(/user=all/);
  await expect(page.getByRole('button', { name: '檢視成員的工作樹' })).toContainText('全部成員');
  await expect(card(page, '未指派')).toBeVisible();
  await page.getByRole('button', { name: '檢視成員的工作樹' }).click();
  await page.getByRole('option', { name: '我自己' }).click();
  await expect(page).not.toHaveURL(/user=/);

  // 無效的成員參數
  await page.goto('/eng?tab=worktrees&user=abc');
  await expect(page.getByText('找不到此成員')).toBeVisible();

  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});
