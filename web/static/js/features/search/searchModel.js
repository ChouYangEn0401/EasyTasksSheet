/**
 * 全站搜尋（Ctrl+K）的純函式：比對、高亮切段、最近開啟、快速前往。
 * docs/design/ui-refresh-2026-11-26.md §7。不碰 DOM、不打 API，方便單獨測。
 */
import { readStorage, writeStorage } from '../../lib/storage.js';

/** 最近開啟的任務（localStorage；只存顯示需要的欄位） */
export const RECENT_KEY = 'ts.cmdk.recent';
export const RECENT_MAX = 8;
/** 每組最多幾筆：任務 8、專案與成員 6 */
export const TASK_LIMIT = 8;
export const GROUP_LIMIT = 6;
/** 輸入 debounce（毫秒） */
export const DEBOUNCE_MS = 150;

/** 空輸入時的「快速前往」；keys 是既有的 G 序列快捷鍵（lib/shortcuts.js GOTO_KEYS），順便教 */
export const QUICK_LINKS = [
  { key: 'overview', label: '總覽', to: '/', keys: 'G O' },
  { key: 'list', label: '清單', to: '/tasks/list', keys: 'G L' },
  { key: 'kanban', label: '看板', to: '/tasks/kanban', keys: 'G K' },
  { key: 'gantt', label: '甘特圖', to: '/tasks/gantt', keys: 'G G' },
  { key: 'me', label: '個人清單', to: '/me', keys: 'G M' },
  { key: 'feedback', label: '問題回饋', to: '/feedback', keys: 'G F' },
];

export const normalizeQuery = (q) => (q ?? '').trim().toLowerCase();

/** 「#12」或「12」→ 12；其他 → null */
export function taskIdQuery(q) {
  const m = /^#?(\d{1,9})$/.exec((q ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * 比對分數（越小越前面；null = 不命中）：
 * 0 完全相同、1 開頭相同、2 某個詞的開頭、3 連續子字串、4 分詞後每個詞都出現。
 */
export function matchScore(text, q) {
  const t = (text ?? '').toLowerCase();
  const nq = normalizeQuery(q);
  if (!nq) return null;
  if (t === nq) return 0;
  if (t.startsWith(nq)) return 1;
  const at = t.indexOf(nq);
  if (at > 0) return /[\s\-_/·（(【[]/.test(t[at - 1]) ? 2 : 3;
  const words = nq.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w))) return 4;
  return null;
}

/** 多個欄位取最好的分數 */
export function bestScore(texts, q) {
  let best = null;
  for (const t of texts) {
    const s = matchScore(t, q);
    if (s != null && (best == null || s < best)) best = s;
  }
  return best;
}

/** 依分數排序後取前 limit 筆；fields(item) 回傳要比對的字串陣列 */
export function rankBy(list, q, fields, limit = GROUP_LIMIT) {
  const scored = [];
  (list ?? []).forEach((item, i) => {
    const s = bestScore(fields(item), q);
    if (s != null) scored.push({ item, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return { total: scored.length, items: scored.slice(0, limit).map((x) => x.item) };
}

/** 專案：比對名稱；未封存的排前面 */
export function filterProjects(projects, q, limit = GROUP_LIMIT) {
  const list = [...(projects ?? [])].sort((a, b) => Number(!!a.isArchived) - Number(!!b.isArchived));
  return rankBy(list, q, (p) => [p.name], limit);
}

/** 成員：比對顯示名稱與帳號；只列啟用中的 */
export function filterUsers(users, q, limit = GROUP_LIMIT) {
  const list = (users ?? []).filter((u) => u.isActive !== false);
  return rankBy(list, q, (u) => [u.displayName, u.username], limit);
}

/** 快速前往也可以用打字找（例如打「看板」） */
export function filterLinks(q) {
  return rankBy(QUICK_LINKS, q, (l) => [l.label], QUICK_LINKS.length).items;
}

/**
 * 高亮切段：回傳 [{ text, hit }]。先找整段連續子字串；找不到再逐詞標。不分大小寫。
 */
export function highlight(text, q) {
  const src = text ?? '';
  const nq = normalizeQuery(q);
  if (!nq || !src) return [{ text: src, hit: false }];
  const lower = src.toLowerCase();
  const ranges = [];
  const whole = lower.indexOf(nq);
  if (whole >= 0) ranges.push([whole, whole + nq.length]);
  else
    for (const w of nq.split(/\s+/).filter(Boolean)) {
      const at = lower.indexOf(w);
      if (at >= 0) ranges.push([at, at + w.length]);
    }
  if (ranges.length === 0) return [{ text: src, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    if (s > pos) out.push({ text: src.slice(pos, s), hit: false });
    out.push({ text: src.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < src.length) out.push({ text: src.slice(pos), hit: false });
  return out;
}

/** 讀最近開啟（壞資料一律當空） */
export function readRecent(storage = { read: readStorage }) {
  try {
    const raw = storage.read(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((x) => x && Number.isInteger(x.id) && x.id > 0 && typeof x.title === 'string')
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 把一筆任務放到最近開啟的最前面（同 id 去重、最多 RECENT_MAX 筆），回傳新清單 */
export function pushRecent(list, task) {
  if (!task || !Number.isInteger(task.id)) return list;
  const entry = {
    id: task.id,
    title: task.title ?? '',
    projectId: task.projectId ?? null,
    statusId: task.statusId ?? null,
    assigneeId: task.assigneeId ?? null,
  };
  return [entry, ...list.filter((x) => x.id !== task.id)].slice(0, RECENT_MAX);
}

export function rememberRecent(task, storage = { read: readStorage, write: writeStorage }) {
  const cur = readRecent(storage);
  const next = pushRecent(cur, task);
  const same =
    cur.length === next.length &&
    cur.every((x, i) => JSON.stringify(x) === JSON.stringify(next[i]));
  if (!same) storage.write(RECENT_KEY, JSON.stringify(next));
  return next;
}

/** Mac 顯示 ⌘，其他顯示 Ctrl */
export function modKeyLabel(nav = typeof navigator !== 'undefined' ? navigator : null) {
  const p = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/i.test(p) ? '⌘' : 'Ctrl';
}
