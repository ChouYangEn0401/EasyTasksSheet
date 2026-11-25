import type { Change } from '../../shared/sync.ts';

/*
 * 即時連線狀態機（純邏輯；EventSource、fetch、計時器皆可注入以便測試）。
 *
 * - 以 SSE（GET /api/events?since=<lastId>）接收「某實體已變更」；連線時伺服器先送 ready，
 *   帶 since 時會重播斷線期間漏掉的流水（無法完整重播時 ready.reset = true → onResync）。
 * - 斷線：關閉後依退避間隔自動重連；同時以 GET /api/changes?since= 探測與補漏
 *   （該請求為 GET，不刷新閒置計時；401 由 api client 統一導回登入頁）。
 * - SSE 連續失敗但 /api/changes 可用（代理擋 SSE 等）→ 退回輪詢（每 30 秒），背景持續嘗試重連。
 * - 從中斷 / 輪詢恢復為即時：onResync（重抓目前頁面資料）。
 * - 不送 heartbeat、不監聽使用者操作：即時連線不影響閒置登出。
 */

export type RealtimeStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'polling';

export type ChangesResponse = {
  changes: Change[];
  latestId: number;
  hasMore: boolean;
  reset: boolean;
};

export type EventSourceLike = {
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
};

export type RealtimeDeps = {
  createSource: (url: string) => EventSourceLike;
  fetchChanges: (since: number | null) => Promise<ChangesResponse>;
  onChanges: (changes: Change[]) => void;
  /** 需要全部重抓（恢復連線、無法完整補漏） */
  onResync: () => void;
  /** 伺服器告知 session 已失效 */
  onExpired: () => void;
  /** 在線狀態變化（SSE `presence` 事件的原始 data；lib/presence.ts） */
  onPresence?: (data: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** 重連退避（ms）；最後一個值為上限 */
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000];
/** SSE 連續失敗幾次（且 /api/changes 可用）後退回輪詢 */
export const FALLBACK_AFTER_FAILURES = 3;
export const POLL_MS = 30_000;
/** 伺服器每 25 秒送一次 ping；超過此時間沒有任何事件即視為斷線 */
export const SILENCE_MS = 60_000;

export type RealtimeSnapshot = {
  status: RealtimeStatus;
  /** 進入中斷（reconnecting / polling）的時間；live 時為 null */
  downSince: number | null;
};

export function createRealtimeClient(deps: RealtimeDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let snapshot: RealtimeSnapshot = { status: 'idle', downSince: null };
  let source: EventSourceLike | null = null;
  let lastId: number | null = null;
  let failures = 0;
  let reconnectTimer: unknown = null;
  let pollTimer: unknown = null;
  let watchdog: unknown = null;
  let running = false;
  let everLive = false;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<RealtimeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((fn) => fn());
  };

  const markDown = (status: 'reconnecting' | 'polling') =>
    set({ status, downSince: snapshot.downSince ?? now() });

  function apply(res: ChangesResponse) {
    if (res.reset || res.hasMore) {
      lastId = res.latestId;
      deps.onResync();
      return;
    }
    if (res.changes.length) deps.onChanges(res.changes);
    lastId = Math.max(lastId ?? 0, res.latestId);
  }

  function closeSource() {
    if (!source) return;
    source.onerror = null;
    source.close();
    source = null;
  }

  function clearTimers() {
    if (reconnectTimer != null) clearTimer(reconnectTimer);
    if (pollTimer != null) clearTimer(pollTimer);
    if (watchdog != null) clearTimer(watchdog);
    reconnectTimer = null;
    pollTimer = null;
    watchdog = null;
  }

  /** 連線中超過 SILENCE_MS 沒收到任何事件（含心跳）→ 視為半開連線而斷線重連 */
  function armWatchdog(es: EventSourceLike) {
    if (watchdog != null) clearTimer(watchdog);
    watchdog = setTimer(() => {
      watchdog = null;
      if (source === es) fail();
    }, SILENCE_MS);
  }

  function connect() {
    if (!running) return;
    closeSource();
    if (snapshot.status === 'idle') set({ status: 'connecting' });
    const url = lastId != null ? `/api/events?since=${lastId}` : '/api/events';
    const es = deps.createSource(url);
    source = es;
    armWatchdog(es);

    es.addEventListener('ping', () => {
      if (source === es) armWatchdog(es);
    });

    es.addEventListener('ready', (e) => {
      if (source !== es) return;
      armWatchdog(es);
      let data: { latestId?: number; reset?: boolean } = {};
      try {
        data = JSON.parse(e.data) as typeof data;
      } catch {
        // 忽略
      }
      const recovering = snapshot.status === 'reconnecting' || snapshot.status === 'polling';
      if (lastId == null || data.reset) lastId = data.latestId ?? lastId ?? 0;
      failures = 0;
      if (pollTimer != null) clearTimer(pollTimer);
      pollTimer = null;
      set({ status: 'live', downSince: null });
      // 第一次連上：頁面資料可能在訂閱生效前就已抓取，期間的變更不會推送 → 重抓一次補上
      // 恢復連線或無法完整重播：同樣重抓
      if (!everLive || recovering || data.reset) deps.onResync();
      everLive = true;
    });

    es.addEventListener('change', (e) => {
      if (source !== es) return;
      armWatchdog(es);
      let change: Change;
      try {
        change = JSON.parse(e.data) as Change;
      } catch {
        return;
      }
      if (lastId != null && change.id <= lastId) return;
      lastId = change.id;
      deps.onChanges([change]);
    });

    es.addEventListener('presence', (e) => {
      if (source !== es) return;
      armWatchdog(es);
      deps.onPresence?.(e.data);
    });

    es.addEventListener('expired', () => {
      if (source !== es) return;
      stop();
      deps.onExpired();
    });

    es.onerror = () => {
      if (source !== es) return;
      fail();
    };
  }

  function fail() {
    closeSource();
    if (watchdog != null) clearTimer(watchdog);
    watchdog = null;
    failures += 1;
    if (snapshot.status !== 'polling') markDown('reconnecting');
    void probe();
    scheduleReconnect();
  }

  /** SSE 失敗時以 /api/changes 補漏並判斷是否退回輪詢 */
  async function probe() {
    try {
      const res = await deps.fetchChanges(lastId);
      if (!running) return;
      apply(res);
      if (failures >= FALLBACK_AFTER_FAILURES && snapshot.status !== 'live') startPolling();
    } catch {
      // 網路錯誤：維持 reconnecting
    }
  }

  function startPolling() {
    if (snapshot.status === 'polling' && pollTimer != null) return;
    markDown('polling');
    const tick = () => {
      pollTimer = setTimer(() => {
        pollTimer = null;
        if (!running || snapshot.status !== 'polling') return;
        deps
          .fetchChanges(lastId)
          .then((res) => running && apply(res))
          .catch(() => undefined)
          .finally(() => {
            if (running && snapshot.status === 'polling') tick();
          });
      }, POLL_MS);
    };
    tick();
  }

  function scheduleReconnect() {
    if (reconnectTimer != null) clearTimer(reconnectTimer);
    const delay =
      snapshot.status === 'polling'
        ? POLL_MS
        : RECONNECT_DELAYS[Math.min(failures - 1, RECONNECT_DELAYS.length - 1)]!;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function stop() {
    running = false;
    closeSource();
    clearTimers();
    set({ status: 'idle', downSince: null });
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      connect();
    },
    stop,
    /**
     * 瀏覽器回報離線（window offline）：既有的 SSE 連線可能不會立即報錯，
     * 主動視為斷線（關閉並進入重連流程）。
     */
    markOffline() {
      if (!running || !source) return;
      fail();
    },
    /** 網路恢復（window online）：立即重連，不等退避 */
    reconnectNow() {
      if (!running || snapshot.status === 'live') return;
      if (reconnectTimer != null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      connect();
    },
    getSnapshot: () => snapshot,
    getLastId: () => lastId,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
