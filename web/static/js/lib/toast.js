import { useSyncExternalStore } from 'preact/compat';

import { truncate } from './format.js';

/*
 * Toast 佇列（docs/design/realtime-feedback.md §2）。純邏輯、不碰 DOM，計時以 setTimeout（可用假時鐘測試）。
 * - 最多同時顯示 3 則，新的在最下方，超過時最舊的先離場
 * - 停留：success 2.5s、info 5s、warning 8s、danger 8s（帶動作鈕時不自動消失）
 * - pause / resume：滑鼠移入、focus、視窗失焦時全部暫停計時
 * - 同 key 的訊息在前一則尚未消失時更新原則內容並重新計時；相同錯誤 2 秒內重複只顯示一則
 * - 連線狀態另有一則常駐 toast（不計入 3 則上限，永遠在最下方）
 */

export const MAX_VISIBLE = 3;
export const EXIT_MS = 150;
export const ERROR_DEDUPE_MS = 2000;

export function defaultDuration(input) {
  switch (input.tone) {
    case 'success':
      return 2500;
    case 'info':
      return 5000;
    case 'warning':
      return 8000;
    case 'danger':
      return input.action ? null : 8000;
  }
}

export function createToastStore({ now = Date.now, exitMs = () => EXIT_MS } = {}) {
  let items = [];
  let connection = null;
  let snapshot = { items, connection };
  let seq = 0;
  const timers = new Map();
  const pauses = new Set();
  const lastError = new Map();
  const listeners = new Set();

  const emit = () => {
    snapshot = { items, connection };
    listeners.forEach((fn) => fn());
  };

  const visible = () => items.filter((t) => !t.leaving);

  function clearTimer(id) {
    const t = timers.get(id);
    if (t?.handle != null) clearTimeout(t.handle);
    timers.delete(id);
  }

  function runTimer(id) {
    const t = timers.get(id);
    if (!t || pauses.size) return;
    if (t.handle != null) clearTimeout(t.handle);
    t.startedAt = now();
    t.handle = setTimeout(() => dismiss(id), t.remaining);
  }

  function startTimer(id, duration) {
    clearTimer(id);
    if (duration == null) return;
    timers.set(id, { handle: null, remaining: duration, startedAt: now() });
    runTimer(id);
  }

  function dismiss(id) {
    const item = items.find((t) => t.id === id);
    if (!item || item.leaving) return;
    clearTimer(id);
    items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    emit();
    setTimeout(() => {
      items = items.filter((t) => t.id !== id);
      emit();
    }, exitMs());
  }

  function show(input) {
    const t = now();
    if (input.tone === 'danger') {
      const dedupeKey = `${input.title}\n${input.description ?? ''}`;
      const prev = lastError.get(dedupeKey);
      if (prev && t - prev.at < ERROR_DEDUPE_MS && items.some((x) => x.id === prev.id && !x.leaving))
        return prev.id;
    }
    const duration = input.duration !== undefined ? input.duration : defaultDuration(input);
    if (input.key) {
      const existing = visible().find((x) => x.key === input.key);
      if (existing) {
        items = items.map((x) =>
          x.id === existing.id ? { ...x, ...input, id: x.id, leaving: false, version: x.version + 1 } : x,
        );
        startTimer(existing.id, duration);
        emit();
        return existing.id;
      }
    }
    const id = ++seq;
    items = [...items, { ...input, id, leaving: false, version: 0 }];
    if (input.tone === 'danger') lastError.set(`${input.title}\n${input.description ?? ''}`, { at: t, id });
    startTimer(id, duration);
    emit();
    const live = visible();
    if (live.length > MAX_VISIBLE)
      for (const old of live.slice(0, live.length - MAX_VISIBLE)) dismiss(old.id);
    return id;
  }

  return {
    show,
    dismiss,
    /** 依 key 關閉（例如他人刪除後關閉對應提示） */
    dismissKey(key) {
      for (const t of visible()) if (t.key === key) dismiss(t.id);
    },
    isActive: (key) => visible().some((t) => t.key === key),
    pause(reason) {
      if (pauses.has(reason)) return;
      const wasRunning = pauses.size === 0;
      pauses.add(reason);
      if (!wasRunning) return;
      const t = now();
      for (const timer of timers.values()) {
        if (timer.handle != null) clearTimeout(timer.handle);
        timer.handle = null;
        timer.remaining = Math.max(0, timer.remaining - (t - timer.startedAt));
      }
    },
    resume(reason) {
      if (!pauses.delete(reason) || pauses.size) return;
      for (const id of timers.keys()) runTimer(id);
    },
    setConnection(next) {
      connection = next;
      emit();
    },
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** 測試用：清空 */
    reset() {
      for (const id of [...timers.keys()]) clearTimer(id);
      items = [];
      connection = null;
      pauses.clear();
      lastError.clear();
      emit();
    },
  };
}

export const toastStore = createToastStore({
  exitMs: () => {
    if (typeof document === 'undefined') return EXIT_MS;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--duration-exit').trim();
    const m = /^([\d.]+)(ms|s)$/.exec(raw);
    return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : EXIT_MS;
  },
});

/** 顯示一則 toast，回傳 id */
export const toast = (input) => toastStore.show(input);
export const dismissToast = (id) => toastStore.dismiss(id);

export function useToasts() {
  return useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
}

// ── 文案工具（§2 文案規則） ─────────────────────────

/** 截斷為 max 字（不加引號）；實作在 format.ts，這裡保留匯出讓既有 import 可用 */
export { truncate };

/** 項目名稱用「」包住並截斷為 20 字 */
export function quoteName(name, max = 20) {
  return `「${truncate(name, max)}」`;
}

let createdCount = 0;
const CREATED_KEY = 'task-created';

/** 建立任務成功：連續建立時合併為「已建立 N 個任務」 */
export function notifyTaskCreated(task, open) {
  createdCount = toastStore.isActive(CREATED_KEY) ? createdCount + 1 : 1;
  if (createdCount === 1)
    toast({
      key: CREATED_KEY,
      tone: 'success',
      title: '已建立任務',
      description: truncate(task.title),
      action: { label: '開啟', onClick: () => open(task.id) },
      duration: defaultDuration({ tone: 'success' }),
    });
  else
    toast({
      key: CREATED_KEY,
      tone: 'success',
      title: `已建立 ${createdCount} 個任務`,
      description: undefined,
      action: undefined,
      duration: defaultDuration({ tone: 'success' }),
    });
}

/** 一般成功訊息（同標題合併、重新計時） */
export function notifySuccess(title) {
  toast({ key: `success:${title}`, tone: 'success', title });
}
