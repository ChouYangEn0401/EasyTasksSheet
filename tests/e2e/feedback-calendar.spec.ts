import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, E2E_USERS, loginViaUi } from '../helpers/e2e.ts';
import { useDataHygiene } from '../helpers/hygiene.ts';

useDataHygiene();

// T4 問題 / 回饋 + 月曆：新增、篩選、拖到某天排程、改期、拖回清單、月份切換、重整保留、編輯、解決、刪除
test.describe.configure({ mode: 'serial' });

type Item = {
  id: number;
  title: string;
  status: string;
  scheduledDate: string | null;
  assigneeId: number | null;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** 頁面（瀏覽器）實際的「今天」YYYY-MM-DD；月曆以瀏覽器本地日期決定本月 */
const pageToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

/** 由「今天」推出本月 / 下月與測試用日期（固定取 10、20 日，與今天是月初或月底無關） */
function monthsOf(todayKey: string) {
  const [y, m] = todayKey.split('-').map(Number) as [number, number];
  const monthKey = `${y}-${pad(m)}`;
  const next = new Date(y, m, 1); // m 為 1 起算 → 下個月 1 日
  const nextMonthKey = `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
  return {
    monthKey,
    heading: `${y} 年 ${m} 月`,
    nextMonthKey,
    nextHeading: `${next.getFullYear()} 年 ${next.getMonth() + 1} 月`,
    DAY_A: `${monthKey}-10`,
    DAY_B: `${monthKey}-20`,
  };
}

async function findItem(page: Page, title: string): Promise<Item> {
  const res = await page.request.get('/api/feedback');
  const item = ((await res.json()) as Item[]).find((i) => i.title === title);
  expect(item, title).toBeTruthy();
  return item!;
}

/** 以滑鼠拖曳（dnd-kit PointerSensor 需移動超過 6px 才啟動） */
async function drag(page: Page, source: Locator, target: Locator) {
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 12, s.y + s.height / 2 + 12, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 15 });
  await page.mouse.up();
  // 等放下動畫結束（動畫期間不會啟動下一次拖曳）
  await expect(page.locator('.fb-card--overlay, .cal-chip--overlay')).toHaveCount(0);
}

const cell = (page: Page, date: string) => page.locator(`[role="gridcell"][data-date="${date}"]`);

test('問題回饋：新增 → 篩選 → 拖曳排程 / 改期 / 取消 → 換月 → 重整保留 → 編輯 → 解決 → 刪除', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await loginViaUi(page, E2E_USERS.member, '/feedback');
  await expect(page).toHaveURL(/\/feedback$/);

  const list = page.getByRole('region', { name: '問題與回饋清單' });
  const calendar = page.getByRole('region', { name: '月曆' });
  await expect(calendar.getByRole('grid')).toBeVisible();
  const { monthKey, heading, nextMonthKey, nextHeading, DAY_A, DAY_B } = monthsOf(await pageToday(page));
  await expect(calendar.getByRole('heading')).toHaveText(heading);

  // 新增：Enter 建立後清空並保持 focus，可連續新增
  const stamp = Date.now();
  const problem = `E2E 離心機溫度異常 ${stamp}`;
  const feedback = `E2E 週報格式建議 ${stamp}`;
  await page.locator('#main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('c');
  const input = page.getByRole('textbox', { name: '新增問題或回饋' });
  await expect(input).toBeFocused();
  await input.fill(problem);
  await input.press('Enter');
  await expect(list.getByText('已建立')).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await page.getByRole('button', { name: '類型' }).click();
  await page.getByRole('option', { name: '回饋' }).click();
  await input.fill(feedback);
  await input.press('Enter');
  await expect(input).toHaveValue('');

  const p = await findItem(page, problem);
  const f = await findItem(page, feedback);
  expect(p).toMatchObject({ status: 'open', scheduledDate: null });
  const pCard = page.getByTestId(`fb-card-${p.id}`);
  const fCard = page.getByTestId(`fb-card-${f.id}`);
  await expect(pCard).toBeVisible();
  await expect(fCard).toBeVisible();
  await expect(pCard.getByText('問題', { exact: true })).toBeVisible();
  await expect(fCard.getByText('回饋', { exact: true })).toBeVisible();
  await expect(pCard.locator('time')).toHaveText('剛剛');

  // 篩選：類型（URL 驅動）
  await list.getByRole('radio', { name: '問題' }).click();
  await expect(page).toHaveURL(/kind=problem/);
  await expect(fCard).toHaveCount(0);
  await expect(pCard).toBeVisible();
  await list.getByRole('button', { name: '清除', exact: true }).click();
  await expect(page).not.toHaveURL(/kind=/);
  await expect(fCard).toBeVisible();

  // 拖到某天 → 已排程
  await drag(page, pCard, cell(page, DAY_A));
  const chip = page.getByTestId(`cal-chip-${p.id}`);
  await expect(cell(page, DAY_A).getByTestId(`cal-chip-${p.id}`)).toBeVisible();
  await expect.poll(async () => (await findItem(page, problem)).scheduledDate).toBe(DAY_A);
  expect((await findItem(page, problem)).status).toBe('scheduled');
  await expect(list.getByRole('region', { name: '已排程' }).getByTestId(`fb-card-${p.id}`)).toBeVisible();

  // 日期間拖曳改期
  await drag(page, cell(page, DAY_A).getByTestId(`cal-chip-${p.id}`), cell(page, DAY_B));
  await expect(cell(page, DAY_B).getByTestId(`cal-chip-${p.id}`)).toBeVisible();
  await expect.poll(async () => (await findItem(page, problem)).scheduledDate).toBe(DAY_B);

  // 狀態篩選同時作用於月曆
  await list.getByRole('button', { name: '狀態篩選' }).click();
  await page.getByRole('option', { name: '未排程' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/status=open/);
  await expect(chip).toHaveCount(0);
  await list.getByRole('button', { name: '清除', exact: true }).click();
  await expect(chip).toBeVisible();

  // 月份切換、回今天（month 存 URL）
  const today = calendar.getByRole('button', { name: '今天' });
  await expect(today).toBeDisabled();
  await calendar.getByRole('button', { name: '下個月' }).click();
  await expect(page).toHaveURL(new RegExp(`month=${nextMonthKey}`));
  await expect(calendar.getByRole('heading')).toHaveText(nextHeading);
  await expect(today).toBeEnabled();
  // 重整後保留月份
  await page.reload();
  await expect(calendar.getByRole('heading')).toHaveText(nextHeading);
  await today.click();
  await expect(page).toHaveURL(new RegExp(`month=${monthKey}`));
  await expect(calendar.getByRole('heading')).toHaveText(heading);

  // 重整後排程保留
  await page.reload();
  await expect(cell(page, DAY_B).getByTestId(`cal-chip-${p.id}`)).toBeVisible();

  // 拖回清單 → 取消排程
  await drag(page, chip, list);
  await expect(chip).toHaveCount(0);
  await expect.poll(async () => (await findItem(page, problem)).status).toBe('open');
  expect((await findItem(page, problem)).scheduledDate).toBeNull();

  // 非拖曳路徑：S 開啟「排入日期」
  await fCard.focus();
  await page.keyboard.press('s');
  const scheduleDialog = page.getByRole('dialog', { name: '排入日期' });
  await expect(scheduleDialog).toBeVisible();
  await scheduleDialog.getByLabel(/排程日/).fill(DAY_A);
  await scheduleDialog.getByRole('button', { name: '排入' }).click();
  await expect(cell(page, DAY_A).getByTestId(`cal-chip-${f.id}`)).toBeVisible();
  await expect.poll(async () => (await findItem(page, feedback)).status).toBe('scheduled');

  // 編輯：點卡片開啟 Dialog，改標題與負責人
  await pCard.click();
  const edit = page.getByRole('dialog', { name: '編輯問題' });
  await expect(edit).toBeVisible();
  await expect(edit.getByText(/更新於/)).toBeVisible();
  const save = edit.getByRole('button', { name: '儲存' });
  await expect(save).toBeDisabled();
  const renamed = `${problem}（已更名）`;
  await edit.getByLabel('標題').fill(renamed);
  await edit.getByLabel('內容').fill('讀數高於設定 3 度');
  await edit.getByLabel('負責人').click();
  await page.getByRole('option', { name: E2E_USERS.admin.displayName }).click();
  await save.click();
  await expect(edit).toHaveCount(0);
  await expect(pCard.getByText(renamed)).toBeVisible();
  await expect(pCard.getByText(E2E_USERS.admin.displayName)).toBeVisible();

  // 標記已解決（保留排程日）→ 移到已解決群組（預設收合）
  await fCard.getByRole('button', { name: /標記「.*」為已解決/ }).click();
  await expect.poll(async () => (await findItem(page, feedback)).status).toBe('resolved');
  expect((await findItem(page, feedback)).scheduledDate).toBe(DAY_A);
  await expect(fCard).toHaveCount(0);
  await list.getByRole('region', { name: '已解決' }).getByRole('button', { expanded: false }).click();
  await expect(fCard).toBeVisible();
  // 已解決 chip 仍顯示在月曆上
  await expect(cell(page, DAY_A).getByTestId(`cal-chip-${f.id}`)).toBeVisible();
  // 重新開啟 → 回到已排程
  await fCard.getByRole('button', { name: /重新開啟/ }).click();
  await expect.poll(async () => (await findItem(page, feedback)).status).toBe('scheduled');

  // 刪除（⋯ 選單 → 確認）
  await pCard.hover();
  await pCard.getByRole('button', { name: /更多動作/ }).click();
  await page.getByRole('menuitem', { name: '刪除' }).click();
  const confirm = page.getByRole('alertdialog', { name: /刪除這筆問題/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '刪除' }).click();
  await expect(pCard).toHaveCount(0);
  const after = (await (await page.request.get('/api/feedback')).json()) as Item[];
  expect(after.find((i) => i.id === p.id)).toBeUndefined();

  // 鍵盤導覽月曆：PageDown 換月、T 回今天。
  // 換月後原本 focus 的格子會被移除，新月份格子的 focus 在下一次 render 後才設定；
  // 須等焦點落到新格子再按 T，否則按鍵會送到 body 而被忽略（先前偶發失敗的原因）。
  await cell(page, DAY_A).focus();
  await expect(cell(page, DAY_A)).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect(page).toHaveURL(new RegExp(`month=${nextMonthKey}`));
  await expect(cell(page, `${nextMonthKey}-01`)).toBeFocused();
  await page.keyboard.press('t');
  // 以按鍵當下頁面的「今天」為準（跨午夜 / 跨月執行時仍正確）
  const todayKey = await pageToday(page);
  await expect(page).toHaveURL(new RegExp(`month=${todayKey.slice(0, 7)}(&|$)`));
  await expect(cell(page, todayKey)).toBeFocused();

  // 清掉本測試留下的項目，重複執行時 DAY_A 不會累積超過格內可顯示的 chip 數
  expect((await page.request.delete(`/api/feedback/${f.id}`)).ok()).toBe(true);

  // 登入前的 /api/auth/me 探測回 401 屬預期
  expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
});

test('1280 / 1024 / 768 寬度不產生水平捲軸', async ({ page }) => {
  await loginViaUi(page, E2E_USERS.member, '/feedback');
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/feedback');
    await expect(page.getByRole('region', { name: '月曆' }).getByRole('grid')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
    if (process.env.SHOTS_DIR)
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/feedback-${width}.png` });
  }
});
