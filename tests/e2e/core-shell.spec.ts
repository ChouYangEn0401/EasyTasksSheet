import { expect, test, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';

// core/shell 冒煙：登入 → 強制改密碼 → 逐一走訪導覽 → 快速新增任務 → 多人可見 → 登出；另測閒置逾時
test.describe.configure({ mode: 'serial' });

const NEW_PASSWORD = 'e2e-newbie-changed-1';

// 走訪只確認 URL 與頁面標題（h1）存在；頁面內容由各功能軌道實作，不在此假設
const NAV_PAGES: { link: string; url: RegExp }[] = [
  { link: '總覽', url: /\/$/ },
  { link: '問題回饋', url: /\/feedback$/ },
  { link: '個人清單', url: /\/me$/ },
  { link: '工程追蹤', url: /\/eng$/ },
];

const TASK_VIEWS: { link: string; url: RegExp }[] = [
  { link: 'List', url: /\/tasks\/list/ },
  { link: 'Kanban', url: /\/tasks\/kanban/ },
  { link: 'Gantt', url: /\/tasks\/gantt/ },
];

const expectPageTitle = async (page: Page) => {
  const h1 = page.locator('h1').first();
  await expect(h1).toBeVisible();
  await expect(h1).not.toHaveText('');
};

test('登入 → 強制改密碼 → 走訪導覽 → 快速新增 → 另一瀏覽器可見 → 登出', async ({ page, browser }) => {
  test.setTimeout(120_000); // 含等待另一瀏覽器的 30 秒輪詢
  const errors = collectErrors(page);

  // 未登入 → 導向登入頁並帶 next
  await page.goto('/tasks/kanban');
  await expect(page).toHaveURL(/\/login\?next=%2Ftasks%2Fkanban/);
  await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();

  // 錯誤密碼
  await page.getByLabel('帳號').fill(E2E_USERS.newbie.username);
  await page.getByLabel('密碼', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page.getByRole('alert')).toHaveText('帳號或密碼不正確');
  await expect(page.getByLabel('密碼', { exact: true })).toHaveValue('');

  // 首次登入 → 強制改密碼
  await page.getByLabel('密碼', { exact: true }).fill(E2E_USERS.newbie.password);
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page.getByRole('heading', { name: '請先設定新密碼' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '請先設定新密碼' })).toBeVisible();
  const submit = page.getByRole('button', { name: '更新密碼' });
  await page.getByLabel('目前密碼', { exact: true }).fill(E2E_USERS.newbie.password);
  await page.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('確認新密碼', { exact: true }).fill(NEW_PASSWORD + 'x');
  await expect(page.getByText('兩次輸入的新密碼不一致')).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.getByLabel('確認新密碼', { exact: true }).fill(NEW_PASSWORD);
  await submit.click();

  // 進入 shell，回到原本要去的頁面
  const nav = page.getByRole('navigation', { name: '主要導覽' });
  await expect(nav).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/kanban$/);
  await expectPageTitle(page);
  // 一般成員看不到成員管理
  await expect(nav.getByRole('link', { name: '成員管理' })).toHaveCount(0);
  // 登入前的 401（/api/auth/me 探測、錯誤密碼）屬預期，之後不得再有 console error
  errors.length = 0;

  // 另一個瀏覽器（admin）先停在任務 List，之後應在輪詢週期內看到新任務
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await loginViaUi(pageB, E2E_USERS.admin, '/tasks/list');
  await expect(
    pageB.getByRole('navigation', { name: '主要導覽' }).getByRole('link', { name: '成員管理' }),
  ).toBeVisible();
  await expect(pageB.getByText('共 0 筆')).toBeVisible();

  // 逐一走訪導覽
  for (const p of NAV_PAGES) {
    await nav.getByRole('link', { name: p.link, exact: true }).click();
    await expect(page).toHaveURL(p.url);
    await expectPageTitle(page);
  }
  // 任務群組：進入上次使用的檢視（Kanban），再走訪三個子項
  await nav.getByRole('link', { name: '任務', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/kanban$/);
  for (const v of TASK_VIEWS) {
    await nav.getByRole('link', { name: v.link, exact: true }).click();
    await expect(page).toHaveURL(v.url);
    await expectPageTitle(page);
  }
  // ViewTabs 切換保留 query
  await page.goto('/tasks/list?status=1');
  await page.getByRole('navigation', { name: '任務檢視' }).getByRole('link', { name: 'Gantt' }).click();
  await expect(page).toHaveURL(/\/tasks\/gantt\?status=1$/);
  await expect(page.getByRole('button', { name: /狀態：待辦/ })).toBeVisible();
  await page.getByRole('button', { name: '清除篩選' }).click();
  await expect(page).toHaveURL(/\/tasks\/gantt$/);

  // 404
  await page.goto('/no-such-page');
  await expect(page.getByText('找不到頁面', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '回到總覽' }).click();
  await expect(page).toHaveURL(/\/$/);

  // 快速新增：N 聚焦 → Enter 建立 → 保持 focus 連續新增
  await page.goto('/tasks/list');
  await expect(page.getByText('共 0 筆')).toBeVisible();
  await page.locator('#main').click({ position: { x: 5, y: 200 } });
  await page.keyboard.press('n');
  const quickAdd = page.getByRole('textbox', { name: '快速新增任務' });
  await expect(quickAdd).toBeFocused();
  const title = `E2E 任務 ${Date.now()}`;
  await quickAdd.fill(title);
  await quickAdd.press('Enter');
  await expect(page.getByText('已建立')).toBeVisible();
  await expect(quickAdd).toHaveValue('');
  await expect(quickAdd).toBeFocused();
  await quickAdd.fill(`${title} 第二筆`);
  await quickAdd.press('Enter');
  await expect(quickAdd).toHaveValue('');
  await quickAdd.press('Escape');
  await expect(quickAdd).not.toBeFocused();
  // 不需重整即更新（FilterBar 結果數與任務清單共用查詢）
  await expect(page.getByText('共 2 筆')).toBeVisible();

  const res = await page.request.get('/api/tasks');
  const tasks = (await res.json()) as { id: number; title: string }[];
  const created = tasks.find((t) => t.title === title);
  expect(created).toBeTruthy();

  // FilterBar：搜尋寫入 URL（debounce）
  await page.keyboard.press('/');
  const search = page.getByRole('textbox', { name: '搜尋任務' });
  await expect(search).toBeFocused();
  await search.fill('第二筆');
  await expect(page).toHaveURL(/q=%E7%AC%AC%E4%BA%8C%E7%AD%86/);
  await expect(page.getByText('共 1 筆')).toBeVisible();
  await page.getByRole('button', { name: '清除篩選' }).click();
  await expect(page.getByText('共 2 筆')).toBeVisible();

  // TaskDrawer：?task=<id> 開啟，Esc 關閉
  await page.goto(`/tasks/list?task=${created!.id}`);
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('待辦')).toBeVisible();
  await expect(drawer.getByText(/更新於/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/\/tasks\/list$/);

  // 另一個瀏覽器在 30 秒輪詢內看到新任務（不重整）
  await expect(pageB.getByText('共 2 筆')).toBeVisible({ timeout: 35_000 });
  await ctxB.close();

  // 登出
  await page.getByRole('button', { name: /使用者選單/ }).click();
  await page.getByRole('menuitem', { name: '登出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
  // 登出後再進入受保護頁面會被導回登入頁
  await page.goto('/eng');
  await expect(page).toHaveURL(/\/login\?next=%2Feng/);

  // 以新密碼可登入
  await page.getByLabel('帳號').fill(E2E_USERS.newbie.username);
  await page.getByLabel('密碼', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page).toHaveURL(/\/eng$/);

  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('閒置逾時後前端自動回到登入頁', async ({ page }) => {
  await page.clock.install();
  await loginViaUi(page, E2E_USERS.admin, '/feedback');
  await expect(page).toHaveURL(/\/feedback$/);
  // 沒有任何操作，快轉超過 60 分鐘閒置門檻
  await page.clock.fastForward(61 * 60_000);
  await expect(page).toHaveURL(/\/login\?reason=expired&next=%2Ffeedback/);
  await expect(page.getByRole('alert')).toHaveText('登入已逾時，請重新登入');
});

test('1280 / 1024 / 768 寬度不產生水平捲軸', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.admin);
  const shots = process.env.SHOTS_DIR;
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', '/tasks/list', '/tasks/kanban?status=1', '/feedback', '/admin/users']) {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: '主要導覽' })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px ${path}`).toBeLessThanOrEqual(0);
      if (shots) await page.screenshot({ path: `${shots}/${width}${path.replace(/[/?=]/g, '_')}.png` });
    }
  }
});
