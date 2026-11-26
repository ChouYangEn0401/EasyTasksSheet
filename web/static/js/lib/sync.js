import { useEffect, useSyncExternalStore } from 'preact/compat';

import { api } from './api.js';
import { enterItem, flashItem, leaveItem, markRemote, taskFxKey } from './motion.js';
import { applyPresenceEvent } from './presence.js';
import { LIST_POLL_MS, queryKeys } from './queryClient.js';
import { createRealtimeClient } from './realtime.js';

/*
 * 多人即時同步（docs/design/realtime-feedback.md §4）：
 * SSE 事件 → 依實體類型 invalidate 對應查詢（含總覽統計）；他人造成的變更另廣播給畫面
 * （就地高亮、抽屜提示條、刪除提示）。自己造成的事件（含自己其他分頁）只靜默更新。
 */

// ── 實體 → 查詢鍵 ───────────────────────────────────

// 稽核紀錄（features/audit）：寫入稽核時沿用主操作本身的流水，收到這些實體的變更即重抓稽核頁與任務活動歷史
const AUDIT = ['audit'];
/** 所有任務詳情（只比對詳情本身，不含其下的子資源；見 flush） */
const TASK_DETAILS = ['tasks', 'detail'];
const TASK_DEPENDENT = [queryKeys.tasks.all, ['overview'], ['personal'], AUDIT];

export const ENTITY_QUERY_KEYS = {
  task: TASK_DEPENDENT,
  project: [queryKeys.projects, ...TASK_DEPENDENT],
  status: [queryKeys.statuses, ...TASK_DEPENDENT],
  property: [queryKeys.properties, queryKeys.tasks.all, AUDIT],
  user: [queryKeys.users, ['admin'], ['overview'], ['personal'], AUDIT],
  feedback: [['feedback'], ['overview']],
  personal: [['personal']],
  repo: [['eng']],
  worktree_plan: [['eng']],
  // 權限設定變更：在線使用者重抓 me（capabilities），畫面即時顯示 / 隱藏功能
  permission: [queryKeys.me, ['admin', 'permissions'], AUDIT],
  // 任務討論區：討論串與清單 / 看板 / 詳情的留言徽章（commentCount、unreadComments）；不重抓任務的其他子資源
  task_comment: [['taskComments'], queryKeys.tasks.lists(), TASK_DETAILS, AUDIT],
};

/** 一批變更需要 invalidate 的查詢鍵（去重；meId 被修改時一併重抓 me） */
export function keysForChanges(changes, meId) {
  const seen = new Map();
  for (const c of changes) {
    for (const k of ENTITY_QUERY_KEYS[c.entityType] ?? []) seen.set(JSON.stringify(k), k);
    if (c.entityType === 'user' && c.entityId === meId) seen.set('me', queryKeys.me);
  }
  return [...seen.values()];
}

/**
 * queryKey 是否屬於 ids 中某任務：詳情與其子資源（['tasks', 'detail', id, ...]：相關任務、依賴、待辦清單）、
 * 討論串（['taskComments', id, ...]）、任務活動歷史（['audit', 'task', id]）
 */
export function isTaskDetailOf(queryKey, ids) {
  const [scope, kind, id] = queryKey;
  if (scope === queryKeys.tasks.all[0] && kind === 'detail') return typeof id === 'number' && ids.has(id);
  if (scope === 'taskComments') return typeof kind === 'number' && ids.has(kind);
  if (scope === 'audit' && kind === 'task') return typeof id === 'number' && ids.has(id);
  return false;
}

/** 自己這個分頁剛寫入後，多久內收到的「自己造成」事件視為回音（本地 mutation 已自行更新快取 / 重抓） */
export const ECHO_WINDOW_MS = 3000;

/**
 * 回音（自己剛寫入造成的 SSE 事件）的重抓範圍：
 * - 'skip'：完全不重抓（討論區留言：本地已重抓該任務的討論串與任務清單）
 * - 'task-echo'：任務事件不重抓清單與該任務詳情本身（本地 mutation 已更新 / 重抓），子資源與其他查詢照常
 * - 'all'：照常
 */

function echoModeFor(entityType, key) {
  if (entityType === 'task_comment' && (key[0] === 'taskComments' || key[0] === queryKeys.tasks.all[0]))
    return 'skip';
  if (entityType === 'task' && key[0] === queryKeys.tasks.all[0]) return 'task-echo';
  return 'all';
}

const MODE_RANK = { skip: 0, 'task-echo': 1, all: 2 };

/** 'task-echo' 時略過的查詢：清單與任務詳情本身（不含子資源） */
function locallyRefreshed(queryKey) {
  if (queryKey[0] !== queryKeys.tasks.all[0]) return false;
  return queryKey[1] === 'list' || (queryKey[1] === 'detail' && queryKey.length === 3);
}

// ── 他人變更廣播 ─────────────────────────────────────

const remoteListeners = new Set();

/** 訂閱他人造成的變更（不含自己） */
export function onRemoteChange(fn) {
  remoteListeners.add(fn);
  return () => {
    remoteListeners.delete(fn);
  };
}

// ── 套用變更到快取 ───────────────────────────────────

const FLUSH_DELAY_MS = 50;

/**
 * 把變更合併後 invalidate；進行中的 mutation（樂觀更新）結束前先延後，避免舊資料蓋過畫面。
 * 他人刪除任務時先播離場動畫，再移除。
 * - 已刪除任務的詳情 / 子資源 / 討論 / 活動歷史不再重抓（只會得到 404），直到收到該任務的 create（還原）
 * - 自己這個分頁剛寫入造成的回音依 echoModeFor 縮小重抓範圍（避免一次寫入觸發兩輪重抓）
 */
export function createChangeApplier(qc, getMeId, now = Date.now) {
  const pending = new Map();
  let timer = null;
  let waitUntil = 0;
  let unsubscribeMutations = null;
  const deletedTaskIds = new Set();
  // 本分頁最近一次寫入成功的時間（回音判斷）
  let lastLocalWrite = Number.NEGATIVE_INFINITY;
  const unsubscribeWrites = qc.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success') lastLocalWrite = now();
  });
  const isLocalEcho = (c, meId) =>
    c.actorId != null &&
    c.actorId === meId &&
    (qc.isMutating() > 0 || now() - lastLocalWrite <= ECHO_WINDOW_MS);

  function flush() {
    timer = null;
    const wait = waitUntil - Date.now();
    if (wait > 0) {
      timer = setTimeout(flush, wait);
      return;
    }
    if (qc.isMutating() > 0) {
      if (!unsubscribeMutations)
        unsubscribeMutations = qc.getMutationCache().subscribe(() => {
          if (qc.isMutating() === 0) {
            unsubscribeMutations?.();
            unsubscribeMutations = null;
            schedule();
          }
        });
      return;
    }
    const entries = [...pending.values()];
    pending.clear();
    // 已刪除任務的詳情與子資源不重抓（抽屜可能仍開著或正在離場，重抓只會得到 404）；關閉後由快取回收
    const gone = new Set(deletedTaskIds);
    for (const { queryKey, mode } of entries) {
      if (mode === 'skip') continue;
      void qc.invalidateQueries({
        queryKey,
        predicate: (q) =>
          !isTaskDetailOf(q.queryKey, gone) &&
          !(mode === 'task-echo' && locallyRefreshed(q.queryKey)) &&
          !(queryKey === TASK_DETAILS && q.queryKey.length > 3),
      });
    }
  }

  function schedule() {
    if (timer == null) timer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function addKey(queryKey, mode) {
    const id = JSON.stringify(queryKey);
    const prev = pending.get(id);
    if (!prev || MODE_RANK[mode] > MODE_RANK[prev.mode]) pending.set(id, { queryKey, mode });
  }

  return {
    apply(changes) {
      const meId = getMeId();
      const t = Date.now();
      for (const c of changes) {
        if (c.entityType === 'task' && c.action === 'delete') deletedTaskIds.add(c.entityId);
        if (c.entityType === 'task' && c.action === 'create') deletedTaskIds.delete(c.entityId);
        const echo = isLocalEcho(c, meId);
        for (const k of keysForChanges([c], meId)) addKey(k, echo ? echoModeFor(c.entityType, k) : 'all');
      }
      for (const c of changes) {
        if (c.actorId != null && c.actorId === meId) continue;
        if (c.entityType === 'task') {
          const key = taskFxKey(c.entityId);
          markRemote(key);
          if (c.action === 'create') enterItem(key);
          else if (c.action === 'update') flashItem(key);
          else waitUntil = Math.max(waitUntil, t + leaveItem(key));
        }
        const remote = { ...c, receivedAt: t };
        remoteListeners.forEach((fn) => fn(remote));
      }
      schedule();
    },
    /** 全部重抓（恢復連線後；重抓造成的變動不播增刪動畫）；已刪除任務的詳情仍不重抓 */
    resync() {
      pending.clear();
      const gone = new Set(deletedTaskIds);
      void qc.invalidateQueries({ predicate: (q) => !isTaskDetailOf(q.queryKey, gone) });
    },
    dispose() {
      if (timer != null) clearTimeout(timer);
      unsubscribeMutations?.();
      unsubscribeWrites();
    },
  };
}
// ── 全域連線 ─────────────────────────────────────────

let client = null;
const statusListeners = new Set();
let unsubscribeClient = null;

const idleSnapshot = { status: 'idle', downSince: null };

export function getRealtimeSnapshot() {
  return client?.getSnapshot() ?? idleSnapshot;
}

/** SSE 正常時為 true（清單 hooks 據此停用 30 秒輪詢） */
export const isRealtimeLive = () => getRealtimeSnapshot().status === 'live';

/** 清單 hooks 的 refetchInterval：即時連線正常時不輪詢，否則 30 秒 */
export const listPollInterval = () => (isRealtimeLive() ? false : LIST_POLL_MS);

export function useRealtimeStatus() {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    getRealtimeSnapshot,
    getRealtimeSnapshot,
  );
}

/**
 * 已登入期間掛載（GlobalOverlays）：建立 SSE 連線、套用變更。
 * 不監聽使用者操作、不送 heartbeat。
 */
export function useRealtimeSync(qc, meId, onExpired) {
  useEffect(() => {
    if (meId == null || typeof EventSource === 'undefined') return;
    const applier = createChangeApplier(qc, () => meId);
    const c = createRealtimeClient({
      createSource: (url) => new EventSource(url, { withCredentials: true }),
      fetchChanges: (since) => api.get(since != null ? `/changes?since=${since}` : '/changes'),
      onChanges: (changes) => applier.apply(changes),
      onResync: () => applier.resync(),
      onExpired,
      onPresence: (data) => applyPresenceEvent(qc, data),
    });
    client = c;
    unsubscribeClient = c.subscribe(() => statusListeners.forEach((fn) => fn()));
    c.start();
    statusListeners.forEach((fn) => fn());
    const onOnline = () => c.reconnectNow();
    const onOffline = () => c.markOffline();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      unsubscribeClient?.();
      unsubscribeClient = null;
      c.stop();
      applier.dispose();
      if (client === c) client = null;
      statusListeners.forEach((fn) => fn());
    };
  }, [qc, meId, onExpired]);
}
