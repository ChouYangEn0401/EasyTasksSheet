import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { PresenceMember, PresenceReport, PresenceResponse } from '../../../shared/presence.ts';
import { api } from '../../lib/api.ts';
import { readTaskParam } from '../../lib/openTask.ts';
import {
  PRESENCE_KEY,
  PRESENCE_POLL_MS,
  createPresenceReporter,
  isPresenceHidden,
  othersOnTask,
  setActiveReporter,
  usePresenceHidden,
  type PresenceReporter,
} from '../../lib/presence.ts';
import { useRealtimeStatus } from '../../lib/sync.ts';
import { apiUrl } from '../../lib/base.ts';

const fetchPresence = ({ signal }: { signal?: AbortSignal }) =>
  api.get<PresenceResponse>('/presence', { signal });

/** 主要查詢（只在頂欄掛一次）：SSE 正常時靠 `presence` 事件更新，中斷時每 15 秒輪詢（GET 不刷新閒置） */
export function usePresenceQuery() {
  const { status } = useRealtimeStatus();
  return useQuery({
    queryKey: PRESENCE_KEY,
    queryFn: fetchPresence,
    refetchInterval: status === 'live' ? false : PRESENCE_POLL_MS,
    staleTime: 10_000,
  });
}

/** 唯讀訂閱（清單列、看板卡片、抽屜）：不自行抓取，跟著主要查詢更新 */
export function usePresenceSelect<T>(select: (data: PresenceResponse) => T) {
  return useQuery({ queryKey: PRESENCE_KEY, queryFn: fetchPresence, enabled: false, select }).data;
}

const EMPTY: PresenceMember[] = [];

/** 也在這個任務上的其他人（編輯中的排前面） */
export function useOthersOnTask(taskId: number, meId: number | null): PresenceMember[] {
  const select = useCallback((d: PresenceResponse) => othersOnTask(d.members, taskId, meId), [taskId, meId]);
  return usePresenceSelect(select) ?? EMPTY;
}

/** 每 30 秒重新整理「N 分鐘前」等相對時間 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll'] as const;

function sendOnExit(body: PresenceReport) {
  try {
    void fetch(apiUrl('/presence'), {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  } catch {
    // 忽略：伺服器逾時後自動轉離線
  }
}

/**
 * 回報自己的動態（已登入期間掛一次）：
 * 路由 / 抽屜 / 隱藏設定改變時送出；有操作時 keepalive；分頁隱藏送 idle；關閉分頁送 away。
 */
export function usePresenceReporter(view: string | null, meId: number | null, keepaliveMs?: number) {
  const [sp] = useSearchParams();
  const drawerTask = readTaskParam(sp);
  const hidden = usePresenceHidden();
  const reporter = useRef<PresenceReporter | null>(null);
  const latest = useRef({ view, drawerTask });
  useEffect(() => {
    latest.current = { view, drawerTask };
  });

  useEffect(() => {
    if (meId == null) return;
    const r = createPresenceReporter({
      send: (body) => api.put('/presence', body),
      sendOnExit,
    });
    reporter.current = r;
    setActiveReporter(r);
    r.start({ ...latest.current, hidden: isPresenceHidden() });
    const onActivity = () => r.activity();
    const onVisibility = () => r.setVisible(document.visibilityState !== 'hidden');
    const onExit = () => r.exit();
    for (const ev of ACTIVITY_EVENTS)
      window.addEventListener(ev, onActivity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onExit);
    if (document.visibilityState === 'hidden') r.setVisible(false);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onExit);
      r.stop();
      setActiveReporter(null);
      if (reporter.current === r) reporter.current = null;
    };
  }, [meId]);

  useEffect(() => reporter.current?.setView(view), [view]);
  useEffect(() => reporter.current?.setDrawerTask(drawerTask), [drawerTask]);
  useEffect(() => reporter.current?.setHidden(hidden), [hidden]);
  useEffect(() => {
    if (keepaliveMs) reporter.current?.setKeepaliveMs(keepaliveMs);
  }, [keepaliveMs]);
}
