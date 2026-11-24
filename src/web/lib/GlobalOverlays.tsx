/**
 * 全域浮層掛載點（由 AppShell 掛載，位於所有頁面之上，已登入時才存在）。
 *
 * core 版為空殼。第二波 T9（feat/realtime-feedback）在此加入：Toast viewport 與佇列、
 * 閒置登出前提醒 Dialog（搭配 useIdleSnapshot / idleTracker.extend / setPaused）、
 * SSE 連線狀態等，只需修改 src/web/lib/** 與 src/web/ui/**，不必動 shell 的凍結檔案。
 */
export function GlobalOverlays() {
  return null;
}
