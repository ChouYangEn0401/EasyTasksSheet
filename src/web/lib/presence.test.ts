import { describe, expect, it, vi } from 'vitest';
import type { PresenceMember, PresenceReport, PresenceResponse } from '../../shared/presence.ts';
import {
  activeMembers,
  createPresenceReporter,
  describeMember,
  mergePresence,
  othersOnTask,
  REPORT_DEBOUNCE_MS,
  taskHintText,
  viewForPath,
} from './presence.ts';
import { createRealtimeClient, type EventSourceLike } from './realtime.ts';

const MIN = 60_000;

const member = (userId: number, extra: Partial<PresenceMember> = {}): PresenceMember => ({
  userId,
  status: 'online',
  view: '甘特圖',
  entity: null,
  lastSeenAt: 0,
  lastView: '甘特圖',
  ...extra,
});

function fakeTimers() {
  let t = 1_000_000;
  let seq = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function setupReporter() {
  const clock = fakeTimers();
  const sent: PresenceReport[] = [];
  const exits: PresenceReport[] = [];
  const r = createPresenceReporter({
    send: async (b) => {
      sent.push(b);
    },
    sendOnExit: (b) => exits.push(b),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { r, clock, sent, exits };
}

describe('createPresenceReporter', () => {
  it('start 立即送出目前頁面；換頁與開抽屜合併為一次', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '清單', drawerTask: null, hidden: false });
    expect(sent).toEqual([{ view: '清單', entity: null, state: 'active', hidden: false }]);
    r.setView('甘特圖');
    r.setDrawerTask(7);
    expect(sent).toHaveLength(1);
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      view: '甘特圖',
      entity: { type: 'task', id: 7, mode: 'viewing' },
      state: 'active',
      hidden: false,
    });
    // 狀態沒變不重送
    r.setView('甘特圖');
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
  });

  it('編輯開始 / 結束回報 editing → viewing', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '清單', drawerTask: 3, hidden: false });
    const end = r.beginEditing(3);
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent.at(-1)?.entity).toEqual({ type: 'task', id: 3, mode: 'editing' });
    end();
    end(); // 重複呼叫無效
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent.at(-1)?.entity).toEqual({ type: 'task', id: 3, mode: 'viewing' });
    // 沒開抽屜時編輯清單中的某列 → 結束後回到無任務
    r.setDrawerTask(null);
    const end2 = r.beginEditing(9);
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent.at(-1)?.entity).toEqual({ type: 'task', id: 9, mode: 'editing' });
    end2();
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent.at(-1)?.entity).toBeNull();
  });

  it('keepalive 只在有操作時送出，且每個間隔最多一次', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '總覽', drawerTask: null, hidden: false });
    expect(sent).toHaveLength(1);
    // 沒有操作：不送
    clock.advance(5 * MIN);
    expect(sent).toHaveLength(1);
    // 久未送出後的第一個操作：立即送（讓大家看到你回來了）
    r.activity();
    expect(sent).toHaveLength(2);
    // 持續操作：每 20 秒最多一次
    for (let i = 0; i < 60; i++) {
      clock.advance(1000);
      r.activity();
    }
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.length).toBeLessThanOrEqual(5);
  });

  it('分頁隱藏送一次 idle 並停止；回來時送 active', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '總覽', drawerTask: null, hidden: false });
    r.setVisible(false);
    expect(sent.at(-1)?.state).toBe('idle');
    const n = sent.length;
    r.activity();
    r.setView('清單');
    clock.advance(5 * MIN);
    expect(sent).toHaveLength(n);
    r.setVisible(true);
    expect(sent.at(-1)).toMatchObject({ state: 'active', view: '清單' });
  });

  it('隱藏我的動態：view / entity 置空、hidden = true', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '清單', drawerTask: 5, hidden: false });
    r.setHidden(true);
    clock.advance(REPORT_DEBOUNCE_MS);
    expect(sent.at(-1)).toEqual({ view: null, entity: null, state: 'active', hidden: true });
  });

  it('關閉分頁送 away；停止後不再送', () => {
    const { r, clock, sent, exits } = setupReporter();
    r.start({ view: '清單', drawerTask: null, hidden: false });
    r.exit();
    expect(exits).toEqual([{ view: '清單', entity: null, state: 'away', hidden: false }]);
    r.stop();
    r.activity();
    r.setView('總覽');
    clock.advance(10 * MIN);
    expect(sent).toHaveLength(1);
  });

  it('伺服器提供較短的 keepalive 間隔時採用', () => {
    const { r, clock, sent } = setupReporter();
    r.start({ view: '清單', drawerTask: null, hidden: false });
    r.setKeepaliveMs(5000);
    clock.advance(1000);
    r.activity();
    clock.advance(4000);
    expect(sent).toHaveLength(2);
  });
});

describe('文案', () => {
  const now = 10 * 3_600_000;
  it('在線：頁面 / 看任務 / 編輯任務 / 隱藏', () => {
    expect(describeMember(member(1), now).doing).toBe('正在看「甘特圖」');
    expect(
      describeMember(
        member(1, { entity: { type: 'task', id: 1, title: 'ntu ranking', mode: 'viewing' } }),
        now,
      ).doing,
    ).toBe('正在專心看「ntu ranking」');
    expect(
      describeMember(
        member(1, { entity: { type: 'task', id: 1, title: 'ntu ranking', mode: 'editing' } }),
        now,
      ).doing,
    ).toBe('正在編輯「ntu ranking」');
    expect(describeMember(member(1, { view: null }), now)).toEqual({
      doing: '在線上',
      when: '剛剛',
      lastOpened: null,
    });
  });

  it('閒置與離線：不顯示精確時間', () => {
    expect(describeMember(member(1, { status: 'idle', lastSeenAt: now - 3 * MIN }), now)).toEqual({
      doing: '剛剛還在看「甘特圖」',
      when: '3 分鐘前',
      lastOpened: null,
    });
    const off = describeMember(
      member(1, { status: 'offline', view: null, lastSeenAt: now - 3 * 3_600_000, lastView: '清單' }),
      now,
    );
    expect(off).toEqual({ doing: '最後上線 3 小時前', when: '', lastOpened: '最後看的是 清單' });
    expect(
      describeMember(member(1, { status: 'offline', lastSeenAt: null, lastView: null }), now).doing,
    ).toBe('還沒有上線紀錄');
  });

  it('抽屜提示條', () => {
    const name = (id: number) => ({ 1: '晴恩', 2: '小明', 3: '阿德' })[id] ?? '?';
    const e = (id: number, mode: 'viewing' | 'editing') => ({ type: 'task' as const, id, title: 't', mode });
    expect(taskHintText([member(1, { entity: e(9, 'viewing') })], name)).toBe('晴恩 也正在看這個任務');
    expect(taskHintText([member(1, { entity: e(9, 'editing') })], name)).toBe('晴恩 正在編輯');
    expect(
      taskHintText([member(1, { entity: e(9, 'editing') }), member(2, { entity: e(9, 'viewing') })], name),
    ).toBe('晴恩 正在編輯 · 小明 也在看');
    expect(
      taskHintText(
        [1, 2, 3].map((id) => member(id, { entity: e(9, 'viewing') })),
        name,
      ),
    ).toBe('晴恩 等 3 人 也正在看這個任務');
  });

  it('頁面名稱', () => {
    expect(viewForPath('/tasks/gantt', '任務')).toBe('甘特圖');
    expect(viewForPath('/tasks/list/', '任務')).toBe('清單');
    expect(viewForPath('/', '總覽')).toBe('總覽');
    expect(viewForPath('/settings/profile', '個人設定')).toBe('個人設定');
  });
});

describe('快取合併與篩選', () => {
  const base: PresenceResponse = {
    members: [member(1), member(2, { status: 'offline', view: null, lastSeenAt: 5, lastView: '總覽' })],
    onlineMs: 45_000,
    idleMs: 300_000,
    keepaliveMs: 20_000,
  };

  it('依 userId 取代；離線事件缺 lastSeen 時沿用', () => {
    const next = mergePresence(base, [
      member(2, { status: 'online', view: '清單', lastSeenAt: 99, lastView: '清單' }),
      member(1, { status: 'offline', view: null, lastSeenAt: null, lastView: null }),
    ])!;
    expect(next.members.find((m) => m.userId === 2)).toMatchObject({ status: 'online', view: '清單' });
    expect(next.members.find((m) => m.userId === 1)).toMatchObject({
      status: 'offline',
      lastSeenAt: 0,
      lastView: '甘特圖',
    });
    expect(mergePresence(undefined, [member(1)])).toBeUndefined();
  });

  it('othersOnTask / activeMembers 排除自己與離線', () => {
    const e = { type: 'task' as const, id: 4, title: 't', mode: 'viewing' as const };
    const list = [
      member(1, { entity: e }),
      member(2, { entity: { ...e, mode: 'editing' } }),
      member(3, { entity: e, status: 'offline' }),
      member(4, { status: 'idle', lastSeenAt: 10 }),
    ];
    expect(othersOnTask(list, 4, 1).map((m) => m.userId)).toEqual([2]);
    expect(othersOnTask(list, 4, null).map((m) => m.userId)).toEqual([2, 1]);
    expect(activeMembers(list, 2).map((m) => m.userId)).toEqual([1, 4]);
  });
});

describe('realtime presence 事件', () => {
  it('把 SSE presence 事件交給 onPresence', () => {
    const listeners = new Map<string, (e: MessageEvent<string>) => void>();
    const source: EventSourceLike = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      close: () => undefined,
      onerror: null,
    };
    const onPresence = vi.fn();
    const c = createRealtimeClient({
      createSource: () => source,
      fetchChanges: async () => ({ changes: [], latestId: 0, hasMore: false, reset: false }),
      onChanges: () => undefined,
      onResync: () => undefined,
      onExpired: () => undefined,
      onPresence,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    c.start();
    listeners.get('presence')?.({ data: '{"members":[]}' } as MessageEvent<string>);
    expect(onPresence).toHaveBeenCalledWith('{"members":[]}');
    c.stop();
  });
});
