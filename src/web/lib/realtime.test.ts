import { describe, expect, it, vi } from 'vitest';
import type { Change } from '../../shared/sync.ts';
import {
  createRealtimeClient,
  FALLBACK_AFTER_FAILURES,
  POLL_MS,
  SILENCE_MS,
  type ChangesResponse,
  type EventSourceLike,
} from './realtime.ts';

class FakeSource implements EventSourceLike {
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

const change = (id: number, extra: Partial<Change> = {}): Change => ({
  id,
  entityType: 'task',
  entityId: 1,
  action: 'update',
  actorId: 2,
  createdAt: 0,
  ...extra,
});

function setup(fetchImpl?: (since: number | null) => Promise<ChangesResponse>) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const sources: FakeSource[] = [];
  const onChanges = vi.fn();
  const onResync = vi.fn();
  const onExpired = vi.fn();
  const fetchChanges = vi.fn(
    fetchImpl ?? (async () => ({ changes: [], latestId: 0, hasMore: false, reset: false })),
  );
  const client = createRealtimeClient({
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    fetchChanges,
    onChanges,
    onResync,
    onExpired,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = async (ms: number) => {
    t += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > t) break;
      timers.shift();
      next.fn();
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const last = () => sources[sources.length - 1]!;
  return { client, sources, last, onChanges, onResync, onExpired, fetchChanges, advance };
}

describe('realtime client', () => {
  it('ready 後為 live；change 事件交給 onChanges，重複 id 略過', () => {
    const { client, last, onChanges, onResync } = setup();
    client.start();
    expect(client.getSnapshot().status).toBe('connecting');
    expect(last().url).toBe('/api/events');
    last().emit('ready', { latestId: 10, reset: false });
    expect(client.getSnapshot()).toEqual({ status: 'live', downSince: null });
    last().emit('change', change(11));
    last().emit('change', change(11));
    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(client.getLastId()).toBe(11);
    // 第一次連上時重抓一次（補上訂閱生效前的空窗）
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('斷線後以退避重連並帶 since；以 /api/changes 補漏；恢復時重抓', async () => {
    const { client, sources, last, onChanges, onResync, fetchChanges, advance } = setup(async () => ({
      changes: [change(12)],
      latestId: 12,
      hasMore: false,
      reset: false,
    }));
    client.start();
    last().emit('ready', { latestId: 10 });
    last().fail();
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(client.getSnapshot().downSince).toBe(0);
    expect(sources[0]!.closed).toBe(true);
    await advance(0);
    expect(fetchChanges).toHaveBeenCalledWith(10);
    expect(onChanges).toHaveBeenCalledWith([change(12)]);
    await advance(1000);
    expect(sources).toHaveLength(2);
    expect(last().url).toBe('/api/events?since=12');
    last().emit('ready', { latestId: 12 });
    expect(client.getSnapshot().status).toBe('live');
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('SSE 連續失敗但 /api/changes 可用時退回輪詢，並持續嘗試重連', async () => {
    const { client, last, fetchChanges, advance } = setup();
    client.start();
    for (let i = 0; i < FALLBACK_AFTER_FAILURES; i++) {
      last().fail();
      await advance(10_000);
    }
    expect(client.getSnapshot().status).toBe('polling');
    const calls = fetchChanges.mock.calls.length;
    await advance(POLL_MS);
    expect(fetchChanges.mock.calls.length).toBeGreaterThan(calls);
    // 背景重連成功 → live
    last().emit('ready', { latestId: 0 });
    expect(client.getSnapshot().status).toBe('live');
  });

  it('無法連線（fetch 也失敗）時維持 reconnecting，不退回輪詢', async () => {
    const { client, last, advance } = setup(async () => {
      throw new Error('offline');
    });
    client.start();
    for (let i = 0; i < 5; i++) {
      last().fail();
      await advance(10_000);
    }
    expect(client.getSnapshot().status).toBe('reconnecting');
  });

  it('reset 或補漏過多時全部重抓', async () => {
    const { client, last, onResync, advance } = setup(async () => ({
      changes: [],
      latestId: 900,
      hasMore: true,
      reset: false,
    }));
    client.start();
    last().emit('ready', { latestId: 1 });
    last().fail();
    await advance(0);
    expect(onResync).toHaveBeenCalled();
    expect(client.getLastId()).toBe(900);
  });

  it('expired 事件：停止並通知', () => {
    const { client, last, onExpired } = setup();
    client.start();
    last().emit('ready', { latestId: 1 });
    last().emit('expired', {});
    expect(onExpired).toHaveBeenCalled();
    expect(client.getSnapshot().status).toBe('idle');
    expect(last().closed).toBe(true);
  });

  it('長時間沒有任何事件（含 ping）視為半開連線；瀏覽器離線時主動斷線', async () => {
    const { client, sources, last, advance } = setup();
    client.start();
    last().emit('ready', { latestId: 1 });
    await advance(SILENCE_MS - 1000);
    last().emit('ping', {});
    await advance(SILENCE_MS - 1000);
    expect(client.getSnapshot().status).toBe('live');
    await advance(2000);
    expect(client.getSnapshot().status).toBe('reconnecting');
    await advance(1000);
    last().emit('ready', { latestId: 1 });
    expect(client.getSnapshot().status).toBe('live');
    client.markOffline();
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(sources.every((s) => s.closed)).toBe(true);
  });

  it('reconnectNow 立即重連', () => {
    const { client, sources, last } = setup();
    client.start();
    last().emit('ready', { latestId: 3 });
    last().fail();
    client.reconnectNow();
    expect(sources).toHaveLength(2);
    expect(last().url).toBe('/api/events?since=3');
  });
});
