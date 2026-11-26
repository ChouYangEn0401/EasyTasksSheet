import { createElement, Fragment } from 'preact';
import { useCallback, useEffect, useRef } from 'preact/compat';
import { useQueryClient } from '../lib/query.js';
import { api } from './api.js';
import { useCurrentUser } from './auth.js';
import { IdleWarning } from './IdleWarning.js';
import { useRealtimeStatus, useRealtimeSync } from './sync.js';
import { toastStore } from './toast.js';
import { ToastHost } from './ToastHost.js';

/**
 * 全域浮層掛載點（由 AppShell 掛載，位於所有頁面之上，已登入時才存在）。
 * - Toast viewport 與佇列（lib/toast.ts）
 * - 閒置登出前提醒 Dialog（lib/IdleWarning.tsx）
 * - 即時同步（SSE，lib/sync.ts）與連線狀態 toast
 */
export function GlobalOverlays() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  // 伺服器告知 session 失效：發一個 GET 讓 api client 收到 401 後統一導回登入頁
  const onExpired = useCallback(() => {
    void api.get('/auth/me').catch(() => undefined);
  }, []);
  useRealtimeSync(qc, me?.id ?? null, onExpired);
  useConnectionToast();
  return createElement(Fragment, null, createElement(ToastHost, null), createElement(IdleWarning, null));
}

/** 中斷多久才顯示「即時更新中斷」 */
const SHOW_DOWN_AFTER_MS = 5_000;
const RECOVERED_MS = 2_500;

/**
 * 連線狀態（§4）：正常或中斷未滿 5 秒不顯示；中斷 5 秒以上 warning（Spinner、不可關閉）；
 * 退回輪詢 info（可關閉）；恢復 success 2.5 秒後消失。
 */
function useConnectionToast() {
  const { status, downSince } = useRealtimeStatus();
  const shown = useRef(false);

  useEffect(() => {
    let timer;
    if (status === 'live') {
      if (shown.current) {
        shown.current = false;
        toastStore.setConnection({ tone: 'success', title: '已恢復即時更新' });
        timer = window.setTimeout(() => toastStore.setConnection(null), RECOVERED_MS);
      }
    } else if (status === 'idle' || status === 'connecting') {
      if (status === 'idle') {
        shown.current = false;
        toastStore.setConnection(null);
      }
    } else if (status === 'polling') {
      shown.current = true;
      toastStore.setConnection({ tone: 'info', title: '目前每 30 秒更新一次', closable: true });
    } else if (status === 'reconnecting' && downSince != null) {
      const show = () => {
        shown.current = true;
        toastStore.setConnection({ tone: 'warning', title: '即時更新中斷，正在重新連線…', spinner: true });
      };
      const wait = downSince + SHOW_DOWN_AFTER_MS - Date.now();
      if (wait <= 0) show();
      else timer = window.setTimeout(show, wait);
    }
    return () => window.clearTimeout(timer);
  }, [status, downSince]);
}
