import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog } from '../ui/index.ts';
import { idleTracker, logout, useIdleSnapshot } from './auth.ts';
import { formatCountdown, idleWarningState } from './idleWarning.ts';
import { toast, toastStore } from './toast.ts';

/*
 * 閒置登出前提醒（docs/design/realtime-feedback.md §6）。
 * - 剩 5 分鐘時以 alertdialog 呈現；「繼續使用」送 heartbeat（一鍵延續），Esc 與點遮罩不關閉
 * - 顯示期間背景操作不視為活動（idleTracker.setPaused）
 * - 多分頁：以 BroadcastChannel 同步閒置期限、延續與登出
 * - 9 小時絕對到期前 5 分鐘：warning toast（不自動消失）
 * SSE 與輪詢不會影響此提醒（它們不呼叫 idleTracker）。
 */

const CHANNEL = 'tasks-sheets-idle';
const ABSOLUTE_KEY = 'absolute-expiry';

type Message = { type: 'deadline'; idleDeadline: number } | { type: 'logout' } | { type: 'expired' };

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

/** 多分頁同步：本分頁期限延後時通知其他分頁；收到較晚的期限即套用 */
function useCrossTabIdle() {
  useEffect(() => {
    const ch = openChannel();
    if (!ch) return;
    let last = idleTracker.getSnapshot().idleDeadline;
    let wasExpired = idleTracker.getSnapshot().expired;
    const unsubscribe = idleTracker.subscribe(() => {
      const s = idleTracker.getSnapshot();
      if (s.idleDeadline != null && (last == null || s.idleDeadline > last)) {
        ch.postMessage({ type: 'deadline', idleDeadline: s.idleDeadline } satisfies Message);
      }
      if (s.expired && !wasExpired) ch.postMessage({ type: 'expired' } satisfies Message);
      last = s.idleDeadline;
      wasExpired = s.expired;
    });
    ch.onmessage = (e: MessageEvent<Message>) => {
      const msg = e.data;
      if (msg?.type === 'deadline') {
        last = Math.max(last ?? 0, msg.idleDeadline);
        idleTracker.syncDeadline(msg.idleDeadline);
      } else if (msg?.type === 'expired') idleTracker.expire();
      else if (msg?.type === 'logout') void logout();
    };
    return () => {
      unsubscribe();
      ch.close();
    };
  }, []);
}

function broadcastLogout() {
  const ch = openChannel();
  if (!ch) return;
  ch.postMessage({ type: 'logout' } satisfies Message);
  ch.close();
}

export function IdleWarning() {
  const snapshot = useIdleSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [extending, setExtending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const announced = useRef(new Set<string>());
  const absoluteShown = useRef(false);
  const savedTitle = useRef<string | null>(null);

  useCrossTabIdle();

  const state = idleWarningState(snapshot, now);
  const near = snapshot.idleDeadline != null || snapshot.absoluteDeadline != null;

  // 倒數：接近期限時每秒更新，平時每 15 秒檢查一次即可
  const fast = state.idle || state.absolute;
  useEffect(() => {
    if (!near) return;
    const t = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 15_000);
    return () => window.clearInterval(t);
  }, [near, fast]);

  // 提醒期間背景操作不算活動
  const open = state.idle;
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setFailed(false);
  }
  useEffect(() => {
    idleTracker.setPaused(open);
    if (!open) announced.current.clear();
    return () => idleTracker.setPaused(false);
  }, [open]);

  // 倒數歸零：直接逾時（清快取並導向登入頁）
  useEffect(() => {
    if (open && state.remainingMs <= 0) idleTracker.expire();
  }, [open, state.remainingMs]);

  // 螢幕閱讀器：出現時（alertdialog 本身）、剩 1 分鐘、剩 30 秒各播報一次
  const secs = Math.ceil(state.remainingMs / 1000);
  useEffect(() => {
    if (!open) return;
    for (const [mark, text] of [
      [60, '剩 1 分鐘將自動登出'],
      [30, '剩 30 秒將自動登出'],
    ] as const) {
      if (secs <= mark && !announced.current.has(text)) {
        announced.current.add(text);
        setAnnounce(text);
      }
    }
  }, [open, secs]);

  // 分頁在背景時把頁面標題改為倒數
  const countdown = formatCountdown(state.remainingMs);
  useEffect(() => {
    if (!open) {
      if (savedTitle.current != null) {
        document.title = savedTitle.current;
        savedTitle.current = null;
      }
      return;
    }
    const update = () => {
      if (document.hidden) {
        if (savedTitle.current == null) savedTitle.current = document.title;
        document.title = `(${countdown}) 即將登出 — TasksSheets`;
      } else if (savedTitle.current != null) {
        document.title = savedTitle.current;
        savedTitle.current = null;
      }
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [open, countdown]);

  // 9 小時絕對到期警示（只發一次）
  useEffect(() => {
    if (state.absolute && !absoluteShown.current) {
      absoluteShown.current = true;
      toast({
        key: ABSOLUTE_KEY,
        tone: 'warning',
        title: '登入將於 5 分鐘後到期',
        description: '已達單次登入上限，無法延長，請先完成手邊的編輯。',
        duration: null,
        action: { label: '知道了', onClick: () => toastStore.dismissKey(ABSOLUTE_KEY) },
      });
    }
    if (snapshot.absoluteDeadline == null) absoluteShown.current = false;
  }, [state.absolute, snapshot.absoluteDeadline]);

  const extend = async () => {
    setExtending(true);
    setFailed(false);
    const before = idleTracker.getSnapshot().idleDeadline;
    await idleTracker.extend();
    setExtending(false);
    const after = idleTracker.getSnapshot();
    if (after.expired) return;
    if (after.idleDeadline == null || after.idleDeadline === before) setFailed(true);
    else setNow(Date.now());
  };

  const danger = state.remainingMs <= 60_000;

  return (
    <>
      <Dialog
        open={open}
        onClose={() => undefined}
        dismissible={false}
        role="alertdialog"
        title="即將自動登出"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                broadcastLogout();
                void logout();
              }}
            >
              立即登出
            </Button>
            <Button variant="primary" data-autofocus loading={extending} onClick={() => void extend()}>
              {failed ? '重試' : '繼續使用'}
            </Button>
          </>
        }
      >
        {failed && (
          <div style={{ marginBottom: 12 }}>
            <Alert tone="danger">無法延長登入，請檢查連線</Alert>
          </div>
        )}
        <p className="m-0">你已有一段時間沒有操作，將在</p>
        <p className="idle-countdown" data-danger={danger || undefined} aria-hidden="true">
          {countdown}
        </p>
        <p className="m-0">後自動登出。</p>
      </Dialog>
      <div className="sr-only" aria-live="assertive" role="status">
        {open ? announce : ''}
      </div>
    </>
  );
}
