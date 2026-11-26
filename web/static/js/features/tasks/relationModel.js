/**
 * 相關任務與複製任務的純函式（feat/task-relations；docs/design/task-list.md §13）。
 */

/** 搜尋選單最多顯示筆數 */
export const RELATION_SEARCH_LIMIT = 8;
/** 複製任務的預設標題後綴（與後端 COPY_SUFFIX 相同） */
export const COPY_SUFFIX = '（複製）';
export const TITLE_MAX = 500;

/**
 * 關聯搜尋結果：排除自己、已關聯者、暫時列（負 id）；保持伺服器排序，最多 limit 筆。
 */
export function relationCandidates(results, selfId, relatedIds, limit = RELATION_SEARCH_LIMIT) {
  const skip = new Set(relatedIds);
  skip.add(selfId);
  const out = [];
  for (const t of results) {
    if (t.id <= 0 || skip.has(t.id)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** 複製任務的預設標題：原標題 +「（複製）」；超過 500 字時截斷原標題（以字元計） */
export function defaultCopyTitle(title) {
  const chars = [...title.trim()];
  const room = TITLE_MAX - COPY_SUFFIX.length;
  return (chars.length > room ? chars.slice(0, room).join('') : chars.join('')) + COPY_SUFFIX;
}

/** 複製對話框的預設狀態：第一個待辦類（category=todo）狀態；沒有時取第一個狀態 */
export function defaultDuplicateStatus(statuses) {
  if (!statuses?.length) return null;
  const sorted = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return (sorted.find((s) => s.category === 'todo') ?? sorted[0]).id;
}

export const COPY_OPTIONS = [
  { key: 'description', label: '描述' },
  { key: 'customFields', label: '自訂欄位' },
  { key: 'dates', label: '開始日與到期日' },
  { key: 'assignee', label: '負責人' },
  { key: 'estimate', label: '預估工時' },
  { key: 'priority', label: '優先度' },
];

export const allCopyOptions = () => ({
  description: true,
  customFields: true,
  dates: true,
  assignee: true,
  estimate: true,
  priority: true,
});

/** 清單 / 看板的連結圖示提示文字 */
export const relationCountLabel = (n) => `${n} 個相關任務`;
