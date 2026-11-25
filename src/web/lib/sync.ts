import { useEffect, useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type { Change, EntityType } from '../../shared/sync.ts';
import { api } from './api.ts';
import { enterItem, flashItem, leaveItem, markRemote, taskFxKey } from './motion.ts';
import { applyPresenceEvent } from './presence.ts';
import { LIST_POLL_MS, queryKeys } from './queryClient.ts';
import { createRealtimeClient, type ChangesResponse, type RealtimeClient } from './realtime.ts';

/*
 * 多人即時同步（docs/design/realtime-feedback.md §4）：
 * SSE 事件 → 依實體類型 invalidate 對應查詢（含總覽統計）；他人造成的變更另廣播給畫面
 * （就地高亮、抽屜提示條、刪除提示）。自己造成的事件（含自己其他分頁）只靜默更新。
 */

// ── 實體 → 查詢鍵 ───────────────────────────────────

const TASK_DEPENDENT: QueryKey[] = [queryKeys.tasks.all, ['overview'], ['personal']];

export const ENTITY_QUERY_KEYS: Record<EntityType, QueryKey[]> = {
  task: TASK_DEPENDENT,
  project: [queryKeys.projects, ...TASK_DEPENDENT],
  status: [queryKeys.statuses, ...TASK_DEPENDENT],
  property: [queryKeys.properties, queryKeys.tasks.all],
  user: [queryKeys.users, ['admin'], ['overview'], ['personal']],
  feedback: [['feedback'], ['overview']],
  personal: [['personal']],
  repo: [['eng']],
  worktree_plan: [['eng']],
  // 權限設定變更：在線使用者重抓 me（capabilities），畫面即時顯示 / 隱藏功能
  permission: [queryKeys.me, ['admin', 'permissions']],
};

/** 一批變更需要 invalidate 的查詢鍵（去重；meId 被修改時一併重抓 me） */
export function keysForChanges(changes: Change[], meId: number | null): QueryKey[] {
  const seen = new Map<string, QueryKey>();
  for (const c of changes) {
    for (const k of ENTITY_QUERY_KEYS[c.entityType] ?? []) seen.set(JSON.stringify(k), k);
    if (c.entityType === 'user' && c.entityId === meId) seen.set('me', queryKeys.me);
  }
  return [...seen.values()];
}

/** queryKey 是否為 ids 中某任務的詳情查詢（['tasks', 'detail', id]） */
export function isTaskDetailOf(queryKey: QueryKey, ids: ReadonlySet<number>): boolean {
  const [scope, kind, id] = queryKey;
  return scope === queryKeys.tasks.all[0] && kind === 'detail' && typeof id === 'number' && ids.has(id);
}

// ── 他人變更廣播 ─────────────────────────────────────

export type RemoteChange = Change & { receivedAt: number };
const remoteListeners = new Set<(c: RemoteChange) => void>();

/** 訂閱他人造成的變更（不含自己） */
export function onRemoteChange(fn: (c: RemoteChange) => void): () => void {
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
 */
export function createChangeApplier(qc: QueryClient, getMeId: () => number | null) {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitUntil = 0;
  let unsubscribeMutations: (() => void) | null = null;
  const deletedTaskIds = new Set<number>();

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
    const keys = [...pending.values()];
    pending.clear();
    // 已刪除任務的詳情查詢不重抓（抽屜可能仍開著，重抓只會得到 404）；關閉後由快取回收
    const gone = new Set(deletedTaskIds);
    deletedTaskIds.clear();
    const refetchable = (q: Query) => !isTaskDetailOf(q.queryKey, gone);
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey, predicate: refetchable });
  }

  function schedule() {
    if (timer == null) timer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  return {
    apply(changes: Change[]) {
      const meId = getMeId();
      for (const k of keysForChanges(changes, meId)) pending.set(JSON.stringify(k), k);
      const t = Date.now();
      for (const c of changes) {
        if (c.entityType === 'task' && c.action === 'delete') deletedTaskIds.add(c.entityId);
        if (c.actorId != null && c.actorId === meId) continue;
        if (c.entityType === 'task') {
          const key = taskFxKey(c.entityId);
          markRemote(key);
          if (c.action === 'create') enterItem(key);
          else if (c.action === 'update') flashItem(key);
          else waitUntil = Math.max(waitUntil, t + leaveItem(key));
        }
        const remote: RemoteChange = { ...c, receivedAt: t };
        remoteListeners.forEach((fn) => fn(remote));
      }
      schedule();
    },
    /** 全部重抓（恢復連線後；重抓造成的變動不播增刪動畫） */
    resync() {
      pending.clear();
      void qc.invalidateQueries();
    },
    dispose() {
      if (timer != null) clearTimeout(timer);
      unsubscribeMutations?.();
    },
  };
}

// ── 全域連線 ─────────────────────────────────────────

let client: RealtimeClient | null = null;
const statusListeners = new Set<() => void>();
let unsubscribeClient: (() => void) | null = null;

const idleSnapshot = { status: 'idle' as const, downSince: null };

export function getRealtimeSnapshot() {
  return client?.getSnapshot() ?? idleSnapshot;
}

/** SSE 正常時為 true（清單 hooks 據此停用 30 秒輪詢） */
export const isRealtimeLive = () => getRealtimeSnapshot().status === 'live';

/** 清單 hooks 的 refetchInterval：即時連線正常時不輪詢，否則 30 秒 */
export const listPollInterval = (): number | false => (isRealtimeLive() ? false : LIST_POLL_MS);

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
export function useRealtimeSync(qc: QueryClient, meId: number | null, onExpired: () => void) {
  useEffect(() => {
    if (meId == null || typeof EventSource === 'undefined') return;
    const applier = createChangeApplier(qc, () => meId);
    const c = createRealtimeClient({
      createSource: (url) => new EventSource(url, { withCredentials: true }),
      fetchChanges: (since) =>
        api.get<ChangesResponse>(since != null ? `/changes?since=${since}` : '/changes'),
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
