/*
 * 討論區草稿的儲存鍵（features/tasks/discussionModel.ts 使用）。
 * 鍵含使用者 id：同一台電腦換人登入不會看到別人的草稿；登出 / session 失效時由 lib/auth.ts 清除該使用者的草稿。
 */

export const DRAFT_PREFIX = 'tasks-sheets:discussion-draft:';

/** 某使用者的草稿鍵前綴（userId 為 null = 未知使用者） */
export const userDraftPrefix = (userId) => `${DRAFT_PREFIX}u${userId ?? 'x'}:`;

export function safeLocalStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** 清除某使用者的所有草稿（含舊版不分使用者的草稿鍵） */
export function clearUserDrafts(storage, userId) {
  try {
    if (!storage?.key || storage.length == null) return;
    const prefix = userDraftPrefix(userId);
    const legacy = /^tasks-sheets:discussion-draft:\d+$/;
    const doomed = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && (k.startsWith(prefix) || legacy.test(k))) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    // 無法使用 localStorage 時略過
  }
}
