/** 日期 / 時間顯示工具（介面時區以瀏覽器為準，預期為 Asia/Taipei） */

const pad = (n) => String(n).padStart(2, '0');

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 相對時間（UpdatedAt 用）：
 * 剛剛（<1 分）、N 分鐘前、N 小時前（同一天內）、昨天、N 天前（<7 天）、MM/DD、跨年 YYYY/MM/DD
 */
export function formatRelative(at, now = Date.now()) {
  const diff = now - at;
  if (diff < 60_000) return '剛剛';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `${Math.floor(diff / 3_600_000)} 小時前`;
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const d = new Date(at);
  const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 2026/11/24 14:32 */
export function formatDateTime(at) {
  const d = new Date(at);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 純日期 YYYY-MM-DD → 2026/11/28 */
export function formatDateOnly(date) {
  return date ? date.replaceAll('-', '/') : '';
}

/** Date → YYYY-MM-DD（本地時區） */
export function toDateString(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天的 YYYY-MM-DD（本地時區） */
export function todayString(now = Date.now()) {
  return toDateString(new Date(now));
}

/** 顯示名稱首字（Avatar）：中文取第一字，英文取首字母大寫 */
export function initialOf(name) {
  const ch = [...name.trim()][0] ?? '?';
  return ch.toUpperCase();
}

/** 去頭尾空白後截斷為 max 字（以字元計，不切斷 emoji 等代理對），超過時補「…」 */
export function truncate(name, max = 20) {
  const chars = [...name.trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 到期日是否已逾期（不含今天） */
export const isOverdue = (dueDate, now = Date.now()) => !!dueDate && dueDate < todayString(now);
