
export const PERSONAL_STATUS_LABEL = {
  todo: '待處理',
  doing: '進行中',
  deferred: '延後',
  cancelled: '取消',
  done: '完成',
};
export const PERSONAL_STATUSES = Object.keys(PERSONAL_STATUS_LABEL);

/** 標記的任務：標記本身 + 任務（已軟刪除的任務不回傳） */

/**
 * 把 list[from] 移到索引 to 時的新 sortOrder：取新鄰居的中間值（sort_order 為 REAL，不必重編號）。
 * list 為移動前的清單（已依 sortOrder 遞增排序）。
 */
export function sortOrderForMove(list, from, to) {
  const rest = list.filter((_, i) => i !== from);
  const prev = rest[to - 1];
  const next = rest[to];
  if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
  if (prev) return prev.sortOrder + 1;
  if (next) return next.sortOrder - 1;
  return list[from]?.sortOrder ?? 0;
}

/* ── 匯報報告（GET /api/personal/report，docs/design/personal.md「匯報報告」） ── */

/** include 查詢參數可用的項目（預設只回完成事項） */
export const REPORT_INCLUDE_KEYS = ['doing', 'deferred', 'cancelled', 'created'];

/** 區間最長天數（含頭尾日），超過回 400 */
export const REPORT_MAX_DAYS = 366;
