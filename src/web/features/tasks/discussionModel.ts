/*
 * 任務討論區的純函式（docs/design/task-discussion.md）：
 * 訊息內容切段（@提及、網址）、@ 選單的觸發與過濾、草稿存取、未讀分隔線、捲動貼底判斷、討論串篩選。
 */
import { safeLocalStorage, userDraftPrefix, type DraftStorage } from '../../lib/drafts.ts';

// ── 型別（對應 server/app/features/task_comments.py 的回應） ──

export type TaskComment = {
  id: number;
  taskId: number;
  parentId: number | null;
  replyToId: number | null;
  authorId: number | null;
  /** 已刪除時為空字串 */
  body: string;
  mentions: number[];
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  deletedBy: number | null;
  threadResolvedAt: number | null;
  threadResolvedBy: number | null;
};

export type CommentThread = TaskComment & {
  /** 最新的至多 10 則回覆（舊→新） */
  replies: TaskComment[];
  /** 回覆總數（含已刪除） */
  replyCount: number;
  lastActivityAt: number;
};

export type ThreadsPage = {
  threads: CommentThread[];
  hasMore: boolean;
  nextBefore: string | null;
  lastReadCommentId: number | null;
};

export type RepliesPage = { replies: TaskComment[]; hasMore: boolean };

export const BODY_MAX = 4000;
/** 串內預設顯示的最新回覆數 */
export const REPLIES_SHOWN = 5;
/** 超過此行數的訊息預設摺疊 */
export const COLLAPSE_LINES = 8;

// ── 內容切段 ─────────────────────────────────────────

export type BodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; username: string }
  | { kind: 'link'; text: string; href: string };

const MENTION_SRC = '(?<![A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})';
/** 網址：遇到空白、角括號、引號或全形標點即結束 */
const LINK_SRC = 'https?:\\/\\/[^\\s<>"，。、；：！？「」『』（）【】]+';
/** 網址尾端常見的標點不算網址 */
const LINK_TRAIL = /[.,;:!?'")\]}>。，、；：！？）」』】]+$/;

/**
 * 把純文字切成文字 / @提及 / 網址段。只有 knownUsernames（小寫）中的帳號才視為提及；
 * 不渲染 HTML，呼叫端以 React 節點輸出。
 */
export function tokenizeBody(body: string, knownUsernames: ReadonlySet<string>): BodySegment[] {
  const re = new RegExp(`${LINK_SRC}|${MENTION_SRC}`, 'g');
  const out: BodySegment[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += text;
    else out.push({ kind: 'text', text });
  };
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const raw = m[0];
    if (raw.startsWith('@')) {
      const name = (m[1] ?? '').replace(/[._-]+$/, '');
      const lower = name.toLowerCase();
      if (!name || !knownUsernames.has(lower)) continue;
      pushText(body.slice(last, m.index));
      out.push({ kind: 'mention', text: `@${name}`, username: lower });
      last = m.index + 1 + name.length;
      re.lastIndex = last;
      continue;
    }
    const href = raw.replace(LINK_TRAIL, '');
    if (href.length <= 'https://'.length) continue;
    pushText(body.slice(last, m.index));
    out.push({ kind: 'link', text: href, href });
    last = m.index + href.length;
    re.lastIndex = last;
  }
  pushText(body.slice(last));
  return out;
}

/** 長訊息（超過 8 行或很長的單段文字）預設摺疊 */
export function shouldCollapse(body: string, lines = COLLAPSE_LINES): boolean {
  return body.split('\n').length > lines || body.length > lines * 70;
}

// ── @ 選單 ───────────────────────────────────────────

/** 游標前是否正在輸入 @帳號：回傳 @ 的位置與已輸入的查詢字（不含 @）；否則 null */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^A-Za-z0-9._-])@([^\s@]{0,32})$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query };
}

export type MentionCandidate = { id: number; username: string; displayName: string; isActive: boolean };

/** 依查詢字過濾成員（只列啟用中）：帳號 / 名稱開頭相符者優先，其次包含；最多 limit 位 */
export function filterMentionCandidates<T extends MentionCandidate>(
  users: T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  const scored: [number, T][] = [];
  for (const u of users) {
    if (!u.isActive) continue;
    const name = u.username.toLowerCase();
    const display = u.displayName.toLowerCase();
    let score: number;
    if (!q) score = 2;
    else if (name.startsWith(q) || display.startsWith(q)) score = 0;
    else if (name.includes(q) || display.includes(q)) score = 1;
    else continue;
    scored.push([score, u]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].displayName.localeCompare(b[1].displayName, 'zh-Hant'));
  return scored.slice(0, limit).map(([, u]) => u);
}

/** 以選定的帳號取代 @查詢字，後面補一個空白；回傳新文字與游標位置 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  username: string,
): { text: string; caret: number } {
  const insert = `@${username} `;
  const after = text.slice(caret).replace(/^\S*/, '');
  const next = text.slice(0, start) + insert + after.replace(/^ /, '');
  return { text: next, caret: start + insert.length };
}

// ── 草稿（以「使用者 + 任務」為單位，存在 localStorage；登出時清除，見 lib/drafts.ts） ──

export type { DraftStorage };
export { safeLocalStorage };

export const draftKey = (userId: number | null, taskId: number) => `${userDraftPrefix(userId)}${taskId}`;

export function loadDraft(storage: DraftStorage | null, userId: number | null, taskId: number): string {
  try {
    return storage?.getItem(draftKey(userId, taskId)) ?? '';
  } catch {
    return '';
  }
}

/** 空白草稿即刪除；超過上限只保留上限內的文字 */
export function saveDraft(
  storage: DraftStorage | null,
  userId: number | null,
  taskId: number,
  text: string,
): void {
  try {
    if (!storage) return;
    if (!text.trim()) storage.removeItem(draftKey(userId, taskId));
    else storage.setItem(draftKey(userId, taskId), text.slice(0, BODY_MAX));
  } catch {
    // 無法使用 localStorage（隱私模式等）時略過
  }
}

// ── 未讀分隔線 / 捲動 ─────────────────────────────────

/**
 * 未讀分隔線放在哪一則訊息之前：依畫面順序找第一則「他人、未刪除、id 大於已讀位置」的訊息。
 * 從未讀過（lastReadId = null）時，所有他人的訊息都算未讀。沒有未讀時回傳 null。
 */
export function firstUnreadId(
  ordered: Pick<TaskComment, 'id' | 'authorId' | 'deletedAt'>[],
  lastReadId: number | null,
  meId: number | null,
): number | null {
  for (const c of ordered) {
    if (c.deletedAt != null) continue;
    if (meId != null && c.authorId === meId) continue;
    if (lastReadId == null || c.id > lastReadId) return c.id;
  }
  return null;
}

/** 是否貼近底部（threshold px 內視為在底部；新訊息到達時才自動跟隨） */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 48,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** 頂端 / 底端是否還有內容（淡出陰影提示） */
export function scrollEdges(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): {
  top: boolean;
  bottom: boolean;
} {
  return { top: el.scrollTop > 2, bottom: el.scrollHeight - el.scrollTop - el.clientHeight > 2 };
}

// ── 篩選與排序 ────────────────────────────────────────

export type ThreadFilter = 'all' | 'open' | 'mine';

export function threadInvolves(t: CommentThread, meId: number | null): boolean {
  if (meId == null) return false;
  return [t, ...t.replies].some((c) => c.authorId === meId || c.mentions.includes(meId));
}

export function filterThreads(
  threads: CommentThread[],
  filter: ThreadFilter,
  meId: number | null,
): CommentThread[] {
  if (filter === 'open') return threads.filter((t) => t.threadResolvedAt == null);
  if (filter === 'mine') return threads.filter((t) => threadInvolves(t, meId));
  return threads;
}

/** 分頁回應（新→舊）合併為畫面順序（舊→新，最新活動的討論串在最下方），以 id 去重 */
export function orderThreads(pages: ThreadsPage[]): CommentThread[] {
  const seen = new Map<number, CommentThread>();
  for (const p of pages) for (const t of p.threads) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.id - b.id);
}

/** 回覆合併（較早載入的 + 列表附帶的最新幾則），以 id 去重並依 id 排序 */
export function mergeReplies(older: TaskComment[], latest: TaskComment[]): TaskComment[] {
  const map = new Map<number, TaskComment>();
  for (const r of older) map.set(r.id, r);
  for (const r of latest) map.set(r.id, r);
  return [...map.values()].sort((a, b) => a.id - b.id);
}
