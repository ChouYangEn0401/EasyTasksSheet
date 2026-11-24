import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/auth.ts';
import { createIdleTracker, HEARTBEAT_THROTTLE_MS } from './idle.ts';

const MIN = 60_000;
const IDLE = 60 * MIN;

function setup(opts: { serverSkew?: number; expiresIn?: number } = {}) {
  let t = 1_000_000;
  const skew = opts.serverSkew ?? 0; // 伺服器時鐘 - 本地時鐘
  const loginAt = t;
  const expiresIn = opts.expiresIn ?? 9 * 60 * MIN;
  const sendHeartbeat = vi.fn(async (): Promise<SessionInfo> => ({
    lastActiveAt: t + skew,
    expiresAt: loginAt + skew + expiresIn,
    idleTimeoutMs: IDLE,
  }));
  const onExpire = vi.fn();
  const tracker = createIdleTracker({ now: () => t, sendHeartbeat, onExpire });
  const advance = (ms: number) => {
    t += ms;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { tracker, sendHeartbeat, onExpire, advance, flush, now: () => t, skew, loginAt };
}

describe('createIdleTracker', () => {
  it('有操作才送 heartbeat，且節流期間只送一次', async () => {
    const { tracker, sendHeartbeat, advance, flush } = setup();
    tracker.tick();
    expect(sendHeartbeat).not.toHaveBeenCalled();

    tracker.activity();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);

    advance(MIN);
    tracker.activity();
    tracker.activity();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('節流期間的操作在期滿後由 tick 補送（trailing）', async () => {
    const { tracker, sendHeartbeat, advance, flush } = setup();
    tracker.activity();
    await flush();
    advance(2 * MIN);
    tracker.activity(); // 待送
    advance(HEARTBEAT_THROTTLE_MS - 2 * MIN - 1);
    tracker.tick();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    advance(1);
    tracker.tick();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('沒有操作時不送 heartbeat，閒置逾時後呼叫 onExpire 一次', async () => {
    const { tracker, sendHeartbeat, onExpire, advance, flush } = setup();
    await tracker.extend();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    advance(IDLE - 1);
    tracker.tick();
    expect(onExpire).not.toHaveBeenCalled();
    advance(1);
    tracker.tick();
    tracker.tick();
    await flush();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot().expired).toBe(true);
  });

  it('持續操作可延長閒置期限', async () => {
    const { tracker, onExpire, advance, flush } = setup();
    await tracker.extend();
    for (let i = 0; i < 30; i++) {
      advance(5 * MIN);
      tracker.activity();
      await flush();
      tracker.tick();
    }
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('寫入請求成功也會延長閒置期限', async () => {
    const { tracker, onExpire, advance } = setup();
    await tracker.extend();
    advance(50 * MIN);
    tracker.noteWrite();
    advance(50 * MIN);
    tracker.tick();
    expect(onExpire).not.toHaveBeenCalled();
    advance(10 * MIN);
    tracker.tick();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('9 小時絕對期限到期即使持續操作也會逾時（考慮時鐘差）', async () => {
    const { tracker, onExpire, advance, flush } = setup({ serverSkew: 7 * MIN, expiresIn: 30 * MIN });
    await tracker.extend();
    advance(29 * MIN);
    tracker.activity();
    await flush();
    tracker.tick();
    expect(onExpire).not.toHaveBeenCalled();
    advance(MIN);
    tracker.tick();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('paused 時操作不算數；reset 後可重新開始', async () => {
    const { tracker, sendHeartbeat, onExpire, advance, flush } = setup();
    await tracker.extend();
    advance(HEARTBEAT_THROTTLE_MS);
    tracker.setPaused(true);
    tracker.activity();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    advance(IDLE);
    tracker.tick();
    expect(onExpire).toHaveBeenCalledTimes(1);

    tracker.reset();
    expect(tracker.getSnapshot()).toEqual({ idleDeadline: null, absoluteDeadline: null, expired: false });
    tracker.activity();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('heartbeat 網路失敗後於節流期滿重試', async () => {
    const { tracker, sendHeartbeat, advance, flush } = setup();
    sendHeartbeat.mockRejectedValueOnce(new Error('offline'));
    tracker.activity();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    advance(HEARTBEAT_THROTTLE_MS);
    tracker.tick();
    await flush();
    expect(sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('subscribe 在 deadline 變動時通知', async () => {
    const { tracker, now } = setup();
    const fn = vi.fn();
    tracker.subscribe(fn);
    await tracker.extend();
    expect(fn).toHaveBeenCalled();
    expect(tracker.getSnapshot().idleDeadline).toBe(now() + IDLE);
  });
});
