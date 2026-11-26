/**
 * 前端閒置偵測（純邏輯，不碰 DOM，方便以假時鐘測試）。
 *
 * - 使用者操作（pointerdown / keydown / wheel）呼叫 activity()；距上次 heartbeat 未滿 throttleMs 時只記為待送，
 *   由 tick() 在節流期滿後補送（trailing），所以「有操作才送 heartbeat，且每 5 分鐘最多一次」。
 * - 寫入請求成功（後端也會刷新閒置計時）呼叫 noteWrite()。
 * - deadline 以本地時鐘換算：idle = 收到回應時間 + idleTimeoutMs；absolute = expiresAt + 時鐘差。
 * - tick() 發現超過任一 deadline 即呼叫 onExpire()（只呼叫一次，直到 reset）。
 * - paused 時操作不計入（T9 閒置提醒顯示期間用）。
 */

export const HEARTBEAT_THROTTLE_MS = 5 * 60_000;

export function createIdleTracker({
  now = Date.now,
  throttleMs = HEARTBEAT_THROTTLE_MS,
  sendHeartbeat,
  onExpire,
}) {
  let snapshot = { idleDeadline: null, absoluteDeadline: null, expired: false };
  let idleTimeoutMs = null;
  let lastSent = Number.NEGATIVE_INFINITY;
  let pending = false;
  let inFlight = null;
  let paused = false;
  const listeners = new Set();

  const set = (patch) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((fn) => fn());
  };

  /** 套用寫入類回應（login / heartbeat / password）的 session 資訊：此時 lastActiveAt ≈ 伺服器現在 */
  function applySession(info, receivedAt = now()) {
    const skew = receivedAt - info.lastActiveAt;
    idleTimeoutMs = info.idleTimeoutMs;
    set({ idleDeadline: receivedAt + info.idleTimeoutMs, absoluteDeadline: info.expiresAt + skew });
  }

  function heartbeat() {
    if (inFlight) return inFlight;
    if (snapshot.expired) return Promise.resolve();
    lastSent = now();
    pending = false;
    inFlight = sendHeartbeat()
      .then((info) => applySession(info))
      .catch(() => {
        // 網路錯誤：保留待送，節流期滿後再試；401 由 api client 統一處理
        pending = true;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function expire() {
    if (snapshot.expired) return;
    set({ expired: true });
    onExpire();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    applySession,
    /** 使用者操作 */
    activity() {
      if (paused || snapshot.expired) return;
      if (now() - lastSent >= throttleMs) void heartbeat();
      else pending = true;
    },
    /** 寫入請求成功：後端已刷新閒置計時 */
    noteWrite() {
      if (snapshot.expired) return;
      const t = now();
      lastSent = t;
      pending = false;
      if (idleTimeoutMs != null) set({ idleDeadline: t + idleTimeoutMs });
    },
    /** 定期呼叫：檢查逾時、補送節流期間累積的操作 */
    tick() {
      if (snapshot.expired) return;
      const t = now();
      const { idleDeadline, absoluteDeadline } = snapshot;
      if (
        (idleDeadline != null && t >= idleDeadline) ||
        (absoluteDeadline != null && t >= absoluteDeadline)
      ) {
        expire();
        return;
      }
      if (pending && !paused && t - lastSent >= throttleMs) void heartbeat();
    },
    /** 立即延續（不受節流限制）；T9「繼續使用」用 */
    extend: heartbeat,
    /** 立即視為逾時 */
    expire,
    /**
     * 其他分頁回報的閒置期限（同一 session）：較晚者為準。只更新本地期限，不送 heartbeat。
     */
    syncDeadline(idleDeadline) {
      if (snapshot.expired || snapshot.idleDeadline == null) return;
      if (idleDeadline <= snapshot.idleDeadline) return;
      set({ idleDeadline });
    },
    setPaused(value) {
      paused = value;
      if (value) pending = false;
    },
    /** 登出 / 重新登入時重設 */
    reset() {
      idleTimeoutMs = null;
      lastSent = Number.NEGATIVE_INFINITY;
      pending = false;
      paused = false;
      set({ idleDeadline: null, absoluteDeadline: null, expired: false });
    },
  };
}
