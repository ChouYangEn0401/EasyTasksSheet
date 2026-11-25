import { useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChangePasswordInput, LoginInput, MeResponse, SessionInfo } from '../../shared/auth.ts';
import type { PublicUser } from '../../shared/users.ts';
import { ApiError, api, onApiEvent } from './api.ts';
import { createIdleTracker } from './idle.ts';
import { currentPath, loginUrl, navigateTo } from './navigation.ts';
import { queryClient, queryKeys } from './queryClient.ts';
import { undoManager } from './undo.ts';

/*
 * 登入狀態、登入 / 登出 / 改密碼、session 逾時處理與閒置偵測。
 * me 查詢的資料：MeResponse（已登入）、null（未登入）。
 */

let ending = false;

/** 正在登出 / 逾時導頁中（路由守衛此時不自行導向，避免蓋掉 reason=expired） */
export const isSessionEnding = () => ending;

function endSession(to: string) {
  ending = true;
  idleTracker.reset();
  // 復原紀錄只屬於這次登入
  undoManager.clear();
  queryClient.setQueryData(queryKeys.me, null);
  navigateTo(to, { replace: true });
  window.setTimeout(() => {
    void queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== queryKeys.me[0] });
  }, 0);
}

/** session 失效（401、閒置逾時、9 小時到期）：導向 /login?reason=expired&next=<原路徑> 並清除快取 */
export function handleSessionExpired() {
  if (ending) return;
  endSession(loginUrl({ reason: 'expired', next: currentPath() }));
}

// 已登入狀態下收到任何 401 → 視為 session 失效
onApiEvent('unauthorized', () => {
  if (queryClient.getQueryData(queryKeys.me)) handleSessionExpired();
});

export const idleTracker = createIdleTracker({
  sendHeartbeat: () => api.post<SessionInfo>('/auth/heartbeat'),
  onExpire: () => {
    // 伺服器端也已逾時；順手清 cookie（logout 為公開路由）
    void api.post('/auth/logout').catch(() => undefined);
    handleSessionExpired();
  },
});

/** 成功後不代表「伺服器已刷新閒置計時」的寫入（/presence：在線回報，伺服器端也不刷新） */
const NOT_ACTIVITY_WRITES = new Set(['/auth/logout', '/auth/login', '/presence']);

onApiEvent('write', (path) => {
  if (!NOT_ACTIVITY_WRITES.has(path)) idleTracker.noteWrite();
});

async function fetchMe(signal?: AbortSignal): Promise<MeResponse | null> {
  try {
    return await api.get<MeResponse>('/auth/me', { signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** 目前登入資訊；data 為 null 代表未登入 */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
  });
}

/** 目前登入者（只在 shell 內使用，登入前為 null） */
export function useCurrentUser(): PublicUser | null {
  return useMe().data?.user ?? null;
}

function onAuthenticated(res: MeResponse) {
  ending = false;
  idleTracker.reset();
  idleTracker.applySession(res.session);
  queryClient.setQueryData(queryKeys.me, res);
}

export function useLogin() {
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input: LoginInput) => api.post<MeResponse>('/auth/login', input),
    onSuccess: onAuthenticated,
  });
}

export function useChangePassword() {
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input: ChangePasswordInput) => api.post<MeResponse>('/auth/password', input),
    onSuccess: onAuthenticated,
  });
}

/** 登出並導向登入頁 */
export async function logout() {
  try {
    await api.post('/auth/logout');
  } catch {
    // 離線時仍在前端登出
  }
  endSession('/login');
}

const TICK_MS = 5_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/**
 * 已登入期間掛載：監聽使用者操作送 heartbeat、定期檢查逾時。
 * 掛載時先送一次 heartbeat（載入頁面本身就是操作），以取得準確的到期時間。
 */
export function useIdleSession() {
  useEffect(() => {
    const onActivity = () => idleTracker.activity();
    const onVisible = () => {
      if (document.visibilityState === 'visible') idleTracker.tick();
    };
    for (const ev of ACTIVITY_EVENTS)
      window.addEventListener(ev, onActivity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => idleTracker.tick(), TICK_MS);
    if (idleTracker.getSnapshot().idleDeadline == null) void idleTracker.extend();
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);
}

/** 閒置狀態（T9 的登出前提醒用）：{ idleDeadline, absoluteDeadline, expired } */
export function useIdleSnapshot() {
  return useSyncExternalStore(idleTracker.subscribe, idleTracker.getSnapshot);
}
