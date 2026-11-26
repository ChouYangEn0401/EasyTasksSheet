/** 與甘特圖、個人頁、管理頁的成員排序一致：顯示名稱以 zh-Hant 定序（同 localeCompare(…, 'zh-Hant')） */
const collator = new Intl.Collator('zh-Hant');

/**
 * 總覽成員排序（與後端條件一致，並補上名稱定序）：
 * 無任務者在前（待辦少 → 多），其後進行中者（逾期多 → 少）；
 * 同條件依顯示名稱（Intl.Collator zh-Hant），最後依使用者 id。
 * 後端（Python）無 ICU，只依數值條件與 id 排序，名稱定序在此處理。
 */
export function compareOverviewMembers(a, b) {
  if (a.idle !== b.idle) return a.idle ? -1 : 1;
  const byCount = a.idle ? a.counts.todo - b.counts.todo : b.overdue - a.overdue;
  return byCount || collator.compare(a.user.displayName, b.user.displayName) || a.user.id - b.user.id;
}

export function sortOverviewMembers(members) {
  return [...members].sort(compareOverviewMembers);
}

/** useQuery 的 select：回傳成員已依名稱重排的總覽資料 */
export function withSortedMembers(data) {
  return { ...data, members: sortOverviewMembers(data.members) };
}
