import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type {
  PresenceMember,
  PresenceMode,
  PresenceReport,
  PresenceResponse,
} from '../../shared/presence.ts';
import { formatRelative } from './format.ts';
import { readStorage, writeStorage } from './storage.ts';

/*
 * 在線感知（docs/design/presence.md）：
 * - 查詢：['presence']（GET /api/presence）；SSE `presence` 事件以 applyPresenceEvent 就地合併。
 * - 回報：createPresenceReporter（純邏輯，計時器可注入以便測試）——路由變更、開關任務抽屜、編輯開始 / 結束
 *   時立即送 PUT；使用者有操作時每 keepaliveMs（≤20 秒）送一次 keepalive；分頁隱藏時送一次 idle 並停止；
 *   關閉分頁送 away（fetch keepalive，失敗則由伺服器逾時轉離線）。
 * - PUT /api/presence 不刷新閒置計時（伺服器端例外），前端也不把它當成「寫入」（lib/auth.ts）。
 */

export const PRESENCE_KEY = ['presence'] as const;
export const PRESENCE_POLL_MS = 15_000;
export const DEFAULT_KEEPALIVE_MS = 20_000;
/** 狀態變更（換頁 + 開抽屜）合併送出的等待時間 */
export const REPORT_DEBOUNCE_MS = 150;

// ── 快取合併 ─────────────────────────────────────────

/** SSE 送來的變更成員合併進快取（依 userId 取代；沒有快取時不建立，等 GET） */
export function mergePresence(
  prev: PresenceResponse | undefined,
  members: PresenceMember[],
): PresenceResponse | undefined {
  if (!prev) return prev;
  const byId = new Map(members.map((m) => [m.userId, m]));
  const next = prev.members.map((m) => {
    const u = byId.get(m.userId);
    if (!u) return m;
    byId.delete(m.userId);
    // 離線事件不帶「最後上線」時沿用既有值
    return { ...u, lastSeenAt: u.lastSeenAt ?? m.lastSeenAt, lastView: u.lastView ?? m.lastView };
  });
  // 新成員（例如剛建立的帳號）：重新 GET 時才會有完整資料，先加入
  for (const m of byId.values()) next.push(m);
  return { ...prev, members: next };
}

/** sync.ts 收到 SSE `presence` 事件時呼叫 */
export function applyPresenceEvent(qc: QueryClient, data: string) {
  let parsed: { members?: PresenceMember[] };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    return;
  }
  if (!Array.isArray(parsed.members)) return;
  qc.setQueryData<PresenceResponse>(PRESENCE_KEY, (prev) => mergePresence(prev, parsed.members!));
}

/** 某任務上的其他人（不含自己、不含離線），編輯中的排前面 */
export function othersOnTask(
  members: readonly PresenceMember[] | undefined,
  taskId: number,
  meId: number | null,
): PresenceMember[] {
  if (!members) return [];
  return members
    .filter((m) => m.userId !== meId && m.status !== 'offline' && m.entity?.id === taskId)
    .sort((a, b) => Number(b.entity?.mode === 'editing') - Number(a.entity?.mode === 'editing'));
}

/** 頂欄堆疊：在線的在前、閒置在後，各自依最後活動新到舊 */
export function activeMembers(members: readonly PresenceMember[] | undefined, meId: number | null) {
  if (!members) return [];
  const rank = (m: PresenceMember) => (m.status === 'online' ? 0 : 1);
  return members
    .filter((m) => m.userId !== meId && m.status !== 'offline')
    .sort((a, b) => rank(a) - rank(b) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

// ── 文案（親切、簡潔、不顯示精確時間）────────────────

const q = (s: string) => `「${s}」`;

export type PresenceText = {
  /** 主要一句：正在看「甘特圖」/ 正在編輯「…」/ 剛剛還在看… */
  doing: string;
  /** 次要：剛剛 / 3 分鐘前；離線為「最後上線 3 小時前」 */
  when: string;
  /** 「最後打開：問題回饋」——只在閒置 / 離線時出現 */
  lastOpened: string | null;
};

export function describeMember(m: PresenceMember, now: number = Date.now()): PresenceText {
  const ago = m.lastSeenAt != null ? formatRelative(Math.min(m.lastSeenAt, now), now) : null;
  if (m.status === 'offline') {
    return {
      doing: ago ? `最後上線 ${ago}` : '還沒有上線紀錄',
      when: '',
      lastOpened: m.lastView ? `最後看的是 ${m.lastView}` : null,
    };
  }
  const e = m.entity;
  if (m.status === 'online') {
    let doing = '在線上';
    if (e) doing = e.mode === 'editing' ? `正在編輯${q(e.title)}` : `正在專心看${q(e.title)}`;
    else if (m.view) doing = `正在看${q(m.view)}`;
    return { doing, when: '剛剛', lastOpened: null };
  }
  // idle：看的是任務時另附所在頁面
  let doing = '暫時離開一下';
  if (e) doing = `剛剛還在看${q(e.title)}`;
  else if (m.view) doing = `剛剛還在看${q(m.view)}`;
  return { doing, when: ago ?? '', lastOpened: e && m.view ? `最後打開：${m.view}` : null };
}

export const STATUS_LABEL = { online: '在線', idle: '閒置', offline: '離線' } as const;

function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join('、');
  return `${names[0]} 等 ${names.length} 人`;
}

/** 任務抽屜提示條：「晴恩 正在編輯」/「晴恩 也正在看這個任務」/「晴恩 正在編輯 · 小明 也在看」 */
export function taskHintText(others: PresenceMember[], nameOf: (id: number) => string): string {
  const editors = others.filter((m) => m.entity?.mode === 'editing').map((m) => nameOf(m.userId));
  const viewers = others.filter((m) => m.entity?.mode !== 'editing').map((m) => nameOf(m.userId));
  if (editors.length && viewers.length)
    return `${joinNames(editors)} 正在編輯 · ${joinNames(viewers)} 也在看`;
  if (editors.length) return `${joinNames(editors)} 正在編輯`;
  if (viewers.length) return `${joinNames(viewers)} 也正在看這個任務`;
  return '';
}

// ── 頁面名稱 ─────────────────────────────────────────

const VIEW_BY_PATH: Record<string, string> = {
  '/': '總覽',
  '/tasks/list': '清單',
  '/tasks/kanban': '看板',
  '/tasks/gantt': '甘特圖',
  '/tasks/delay-link': '延遲鏈',
  '/feedback': '問題回饋',
  '/me': '個人清單',
  '/eng': '工程追蹤',
  '/admin/users': '成員管理',
  '/admin/data': '資料管理',
};

/** 路徑 → 頁面名稱（未列出的路徑用頁面標題） */
export function viewForPath(pathname: string, fallback: string): string | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return VIEW_BY_PATH[p] ?? (fallback ? fallback.slice(0, 40) : null);
}

// ── 隱藏我的動態（localStorage）──────────────────────

export const PRESENCE_HIDDEN_KEY = 'presence.hideActivity';
const hiddenListeners = new Set<() => void>();

export const isPresenceHidden = () => readStorage(PRESENCE_HIDDEN_KEY) === '1';

export function setPresenceHidden(hidden: boolean) {
  writeStorage(PRESENCE_HIDDEN_KEY, hidden ? '1' : null);
  hiddenListeners.forEach((fn) => fn());
}

export function usePresenceHidden(): boolean {
  return useSyncExternalStore((fn) => {
    hiddenListeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === PRESENCE_HIDDEN_KEY) fn();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      hiddenListeners.delete(fn);
      window.removeEventListener('storage', onStorage);
    };
  }, isPresenceHidden);
}

// ── 回報器 ───────────────────────────────────────────

export type ReporterDeps = {
  send: (body: PresenceReport) => Promise<unknown>;
  /** 關閉分頁時送出（fetch keepalive）；可省略 */
  sendOnExit?: (body: PresenceReport) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function createPresenceReporter(deps: ReporterDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let running = false;
  let view: string | null = null;
  let drawerTask: number | null = null;
  /** 編輯中的任務（同一任務可能同時有多個編輯器，以計數處理） */
  const editing = new Map<number, number>();
  let editOrder: number[] = [];
  let hidden = false;
  let visible = true;
  let keepaliveMs = DEFAULT_KEEPALIVE_MS;
  let lastActivity = Number.NEGATIVE_INFINITY;
  let lastSent = Number.NEGATIVE_INFINITY;
  let lastKey = '';
  let debounce: unknown = null;
  let keepalive: unknown = null;
  let failures = 0;

  function entity(): PresenceReport['entity'] {
    const editId = editOrder[editOrder.length - 1];
    if (editId != null) return { type: 'task', id: editId, mode: 'editing' };
    if (drawerTask != null) return { type: 'task', id: drawerTask, mode: 'viewing' as PresenceMode };
    return null;
  }

  function body(state: PresenceReport['state']): PresenceReport {
    return {
      view: hidden ? null : view,
      entity: hidden ? null : entity(),
      state,
      hidden,
    };
  }

  function send(state: PresenceReport['state']) {
    const b = body(state);
    lastKey = JSON.stringify(b);
    lastSent = now();
    deps.send(b).then(
      () => {
        failures = 0;
      },
      () => {
        // 網路錯誤：下一次操作 / keepalive 再送（不重試洪水）
        failures += 1;
        lastKey = '';
      },
    );
  }

  /** 狀態（頁面 / 任務 / 隱藏）改變：合併後立即送出 */
  function changed() {
    if (!running || !visible) return;
    if (debounce != null) clearTimer(debounce);
    debounce = setTimer(() => {
      debounce = null;
      if (!running || !visible) return;
      if (JSON.stringify(body('active')) !== lastKey) send('active');
    }, REPORT_DEBOUNCE_MS);
  }

  function scheduleKeepalive() {
    if (keepalive != null) clearTimer(keepalive);
    keepalive = setTimer(() => {
      keepalive = null;
      if (!running || !visible) return;
      // 只有在上次送出後「有操作」才送 keepalive：無操作時讓伺服器自然轉為閒置 / 離線
      if (lastActivity > lastSent) send('active');
      scheduleKeepalive();
    }, keepaliveMs);
  }

  return {
    start(initial: { view: string | null; drawerTask: number | null; hidden: boolean }) {
      if (running) return;
      running = true;
      view = initial.view;
      drawerTask = initial.drawerTask;
      hidden = initial.hidden;
      visible = true;
      lastActivity = now();
      send('active');
      scheduleKeepalive();
    },
    stop() {
      running = false;
      if (debounce != null) clearTimer(debounce);
      if (keepalive != null) clearTimer(keepalive);
      debounce = null;
      keepalive = null;
    },
    setView(v: string | null) {
      if (v === view) return;
      view = v;
      changed();
    },
    setDrawerTask(id: number | null) {
      if (id === drawerTask) return;
      drawerTask = id;
      changed();
    },
    setHidden(h: boolean) {
      if (h === hidden) return;
      hidden = h;
      changed();
    },
    /** 開始就地編輯某任務；回傳結束函式（失焦即回 viewing） */
    beginEditing(taskId: number): () => void {
      editing.set(taskId, (editing.get(taskId) ?? 0) + 1);
      editOrder = [...editOrder.filter((id) => id !== taskId), taskId];
      changed();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (editing.get(taskId) ?? 1) - 1;
        if (n <= 0) {
          editing.delete(taskId);
          editOrder = editOrder.filter((id) => id !== taskId);
        } else editing.set(taskId, n);
        changed();
      };
    },
    /** 使用者操作（pointer / key / wheel / scroll）；距上次送出已超過 keepalive 間隔時立即送 */
    activity() {
      lastActivity = now();
      if (!running || !visible) return;
      if (lastActivity - lastSent >= keepaliveMs) send('active');
    },
    /** 分頁顯示 / 隱藏：隱藏時送一次 idle 並停止 keepalive；回來時立即送 active */
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      if (!running) return;
      if (!v) {
        if (debounce != null) clearTimer(debounce);
        if (keepalive != null) clearTimer(keepalive);
        debounce = null;
        keepalive = null;
        send('idle');
      } else {
        lastActivity = now();
        send('active');
        scheduleKeepalive();
      }
    },
    /** 關閉分頁（pagehide） */
    exit() {
      if (!running) return;
      deps.sendOnExit?.(body('away'));
    },
    setKeepaliveMs(ms: number) {
      if (!(ms > 0) || ms === keepaliveMs) return;
      keepaliveMs = ms;
      if (running && visible) scheduleKeepalive();
    },
    /** 測試用 */
    getFailures: () => failures,
  };
}

export type PresenceReporter = ReturnType<typeof createPresenceReporter>;

/** 全域回報器（由 features/presence/usePresenceRuntime 建立）；就地編輯元件透過 reportEditing 使用 */
let activeReporter: PresenceReporter | null = null;
export function setActiveReporter(r: PresenceReporter | null) {
  activeReporter = r;
}

/** 就地編輯某任務開始（EditableField、描述輸入）：回傳結束函式；未登入或尚未掛載時為 no-op */
export function reportEditing(taskId: number): () => void {
  if (taskId <= 0 || !activeReporter) return () => undefined;
  return activeReporter.beginEditing(taskId);
}
