
export const STATUS_CATEGORIES = ['todo', 'doing', 'done'];

/** 標籤 / 專案 / 狀態 / select 選項共用調色盤鍵名（DB 存鍵名，不存色碼；色值見 docs/design/core-shell.md） */
export const TAG_COLORS = ['gray', 'blue', 'purple', 'green', 'yellow', 'orange', 'red', 'teal'];

const color = tagColor;

/** PATCH /api/statuses/:id；DELETE 時仍有任務（含已刪除任務）使用則 409 */
export const statusUpdateInput = statusCreateInput.partial();
