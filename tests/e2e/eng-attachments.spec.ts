import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// 問題的附件（圖片 / 影片上傳、燈箱、刪除、失敗卡片）與連結預覽（本機測試頁）。
// E2E 伺服器以 LINK_PREVIEW_ALLOW_PRIVATE=true 啟動（僅限 E2E），才能抓 127.0.0.1 的測試頁。
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const FIXTURES = resolve('tests/fixtures');

const issueRow = (page: Page, title: string) => page.locator('tr.eng-issue-row').filter({ hasText: title });

async function createIssue(page: Page, title: string, url?: string) {
  const form = page.getByRole('form', { name: '新增問題' });
  await form.getByLabel('標題').fill(title);
  if (url) await form.getByLabel('連結').fill(url);
  await form.getByRole('button', { name: '新增問題' }).click();
  await expect(issueRow(page, title)).toBeVisible();
}

async function expand(page: Page, title: string) {
  await page.getByRole('button', { name: `展開「${title}」的附件與詳細` }).click();
  await expect(page.getByRole('button', { name: `收合「${title}」的附件與詳細` })).toBeVisible();
}

test('附件：上傳圖片與影片 → 縮圖格 → 燈箱預覽（影片可載入）→ 刪除', async ({ page }) => {
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/eng');
  const title = `E2E 附件 ${stamp}`;
  await createIssue(page, title);
  await expand(page, title);

  const detail = page.locator('tr.eng-detail-row');
  const drop = detail.getByRole('button', { name: /新增附件/ });
  await expect(drop).toContainText('拖放檔案到這裡');
  await expect(drop).toContainText('25 MB');

  // 鍵盤：拖放區可聚焦，Enter 開啟檔案選擇器
  // （列表在背景重新整理時列可能被重新排列而失去焦點，失敗就重新聚焦再按一次）
  let chooser: FileChooser | null = null;
  for (let i = 0; i < 3 && !chooser; i++) {
    await drop.focus();
    const waiting = page.waitForEvent('filechooser', { timeout: 3_000 }).catch(() => null);
    await page.keyboard.press('Enter');
    chooser = await waiting;
  }
  if (!chooser) throw new Error('按 Enter 沒有開啟檔案選擇器');
  await chooser.setFiles([resolve(FIXTURES, 'screenshot.png'), resolve(FIXTURES, 'sample.webm')]);

  const grid = detail.locator('.eng-att-grid');
  await expect(grid.locator('.eng-tile:not(.eng-tile--upload)')).toHaveCount(2, { timeout: 15_000 });
  await expect(grid.getByText('screenshot.png')).toBeVisible();
  await expect(grid.getByText('sample.webm')).toBeVisible();
  // 收合時的小標記
  await expect(issueRow(page, title).getByLabel('2 個附件')).toBeVisible();

  // 圖片縮圖可載入
  const thumb = grid.locator('.eng-tile[data-kind="image"] img');
  await expect(thumb).toBeVisible();
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // 燈箱：圖片 → → 切到影片，video 可載入 metadata（Range 支援）→ Esc 關閉
  await grid.getByRole('button', { name: '預覽「screenshot.png」' }).click();
  const box = page.getByRole('dialog', { name: /附件預覽/ });
  await expect(box.locator('img')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  const video = box.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);

  // 下載標頭：影片支援 Range
  const href = await grid.locator('.eng-tile[data-kind="video"] a[download]').getAttribute('href');
  const ranged = await page.request.get(href!.replace('?download=1', ''), {
    headers: { Range: 'bytes=0-15' },
  });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()['content-range']).toMatch(/^bytes 0-15\//);

  // 不支援的類型：顯示失敗卡片與原因，可移除
  await detail.locator('input[type=file]').setInputFiles({
    name: 'virus.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('MZ'),
  });
  const failed = grid.locator('.eng-tile--upload[data-status="error"]');
  await expect(failed).toContainText('不支援的檔案類型');
  await failed.getByRole('button', { name: '移除' }).click();
  await expect(failed).toHaveCount(0);

  // 偽造內容（副檔名 png、內容不是圖片）：伺服器拒絕，卡片顯示伺服器訊息
  await detail.locator('input[type=file]').setInputFiles({
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<html>not a png</html>'),
  });
  await expect(grid.locator('.eng-tile--upload[data-status="error"]')).toContainText('內容與副檔名不符');
  await grid.locator('.eng-tile--upload').getByRole('button', { name: '移除' }).click();

  // 刪除（需確認）
  await grid.getByRole('button', { name: '刪除「screenshot.png」' }).click();
  const confirm = page.getByRole('alertdialog', { name: '刪除附件？' });
  await confirm.getByRole('button', { name: '刪除' }).click();
  await expect(grid.getByText('screenshot.png')).toHaveCount(0);
  await expect(issueRow(page, title).getByLabel('1 個附件')).toBeVisible();

  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});

test('附件：新增問題時先貼上 / 選擇檔案，建立後自動上傳', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member, '/eng');
  const title = `E2E 先附檔 ${stamp}`;
  const form = page.getByRole('form', { name: '新增問題' });
  await form.getByLabel('選擇附件').setInputFiles(resolve(FIXTURES, 'screenshot.png'));
  await expect(form.getByText('screenshot.png')).toBeVisible();
  await form.getByLabel('標題').fill(title);
  await form.getByRole('button', { name: '新增問題' }).click();
  // 建立後自動展開並上傳
  const detail = page.locator('tr.eng-detail-row');
  await expect(detail.locator('.eng-tile:not(.eng-tile--upload)')).toHaveCount(1, { timeout: 15_000 });
  await expect(issueRow(page, title).getByLabel('1 個附件')).toBeVisible();
});

test.describe('連結預覽', () => {
  let server: Server;
  let base = '';
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>備用標題</title>
<meta property="og:title" content="E2E 測試頁 ${stamp}">
<meta property="og:description" content="這是給連結預覽的說明 &lt;script&gt;">
<meta property="og:site_name" content="E2E Site">
</head><body><p>內文第一段</p><script>document.title='x'</script></body></html>`,
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(() => {
    server.close();
  });

  test('貼連結後顯示網頁預覽卡片（標題、說明、網站），開新分頁連結', async ({ page }) => {
    const errors = collectErrors(page);
    await loginViaUi(page, E2E_USERS.member, '/eng');
    const title = `E2E 連結 ${stamp}`;
    await createIssue(page, title, `${base}/page`);
    await expand(page, title);
    const card = page.locator('tr.eng-detail-row .eng-preview-card');
    await expect(async () => {
      if ((await card.count()) === 0) {
        const btn = page.getByRole('button', { name: '重新取得預覽' });
        if (await btn.isVisible()) await btn.click();
      }
      await expect(card).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(card).toContainText(`E2E 測試頁 ${stamp}`);
    await expect(card).toContainText('這是給連結預覽的說明 <script>');
    await expect(card).toContainText('E2E Site');
    await expect(card).toHaveAttribute('target', '_blank');
    await expect(card).toHaveAttribute('rel', 'noopener noreferrer');
    expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
  });
});
