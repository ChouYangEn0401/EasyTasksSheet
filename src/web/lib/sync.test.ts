import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Change } from '../../shared/sync.ts';
import { queryKeys } from './queryClient.ts';
import { ECHO_WINDOW_MS, createChangeApplier, isTaskDetailOf, keysForChanges } from './sync.ts';

describe('keysForChanges', () => {
  it('權限設定變更：重抓 me 與權限設定頁', () => {
    const keys = keysForChanges([change({ entityType: 'permission', entityId: 0, actorId: 99 })], 1);
    expect(keys).toContainEqual(queryKeys.me);
    expect(keys).toContainEqual(['admin', 'permissions']);
  });
});

const change = (over: Partial<Change>): Change => ({
  id: 1,
  entityType: 'task',
  entityId: 7,
  action: 'update',
  actorId: 1,
  createdAt: 0,
  ...over,
});

describe('isTaskDetailOf', () => {
  it('比對指定 id 任務的詳情與其子資源、討論串、活動歷史', () => {
    const ids = new Set([7]);
    expect(isTaskDetailOf(queryKeys.tasks.detail(7), ids)).toBe(true);
    expect(isTaskDetailOf([...queryKeys.tasks.detail(7), 'checklist'], ids)).toBe(true);
    expect(isTaskDetailOf(['taskComments', 7, 'threads'], ids)).toBe(true);
    expect(isTaskDetailOf(['audit', 'task', 7], ids)).toBe(true);
    expect(isTaskDetailOf(queryKeys.tasks.detail(8), ids)).toBe(false);
    expect(isTaskDetailOf(queryKeys.tasks.lists(), ids)).toBe(false);
    expect(isTaskDetailOf(['feedback', 'detail', 7], ids)).toBe(false);
    expect(isTaskDetailOf(['audit', 'list', {}], ids)).toBe(false);
  });
});

function setup() {
  vi.useFakeTimers();
  // 他人變更會播動畫（lib/motion.ts 使用 window.setTimeout）
  vi.stubGlobal('window', globalThis);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fetched: string[] = [];
  const unsubs: (() => void)[] = [];
  const observe = (key: readonly unknown[]) => {
    const obs = new QueryObserver(qc, {
      queryKey: key,
      queryFn: () => {
        fetched.push(JSON.stringify(key));
        return 'x';
      },
    });
    unsubs.push(obs.subscribe(() => {}));
  };
  return {
    qc,
    fetched,
    observe,
    has: (key: readonly unknown[]) => fetched.includes(JSON.stringify(key)),
    cleanup: () => {
      unsubs.forEach((u) => u());
      qc.clear();
    },
  };
}

describe('createChangeApplier', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('任務刪除後不重抓該任務的詳情、子資源、討論與活動歷史（避免 404），直到收到還原（create）', async () => {
    const s = setup();
    const sub = [...queryKeys.tasks.detail(7), 'relations'];
    for (const k of [
      queryKeys.tasks.detail(7),
      sub,
      ['taskComments', 7, 'threads'],
      ['audit', 'task', 7],
      queryKeys.tasks.detail(8),
      queryKeys.tasks.lists(),
    ])
      s.observe(k);
    await vi.runAllTimersAsync();
    s.fetched.length = 0;

    const applier = createChangeApplier(s.qc, () => 1);
    applier.apply([change({ action: 'delete', entityId: 7, actorId: 2 })]);
    await vi.runAllTimersAsync();
    expect(s.has(queryKeys.tasks.detail(7))).toBe(false);
    expect(s.has(sub)).toBe(false);
    expect(s.has(['audit', 'task', 7])).toBe(false);
    expect(s.has(queryKeys.tasks.detail(8))).toBe(true);
    expect(s.has(queryKeys.tasks.lists())).toBe(true);

    // 之後的其他任務事件也不重抓已刪除任務（抽屜維持「已被刪除」）
    s.fetched.length = 0;
    applier.apply([change({ action: 'update', entityId: 8, actorId: 2 })]);
    applier.apply([change({ entityType: 'task_comment', action: 'create', entityId: 50, actorId: 2 })]);
    await vi.runAllTimersAsync();
    expect(s.has(queryKeys.tasks.detail(8))).toBe(true);
    expect(s.has(queryKeys.tasks.detail(7))).toBe(false);
    expect(s.has(['taskComments', 7, 'threads'])).toBe(false);

    // 還原（create）後恢復
    s.fetched.length = 0;
    applier.apply([change({ action: 'create', entityId: 7, actorId: 2 })]);
    await vi.runAllTimersAsync();
    expect(s.has(queryKeys.tasks.detail(7))).toBe(true);
    expect(s.has(sub)).toBe(true);

    applier.dispose();
    s.cleanup();
  });

  it('留言事件只重抓討論串、清單與詳情本身，不重抓任務的其他子資源', async () => {
    const s = setup();
    const sub = [...queryKeys.tasks.detail(7), 'checklist'];
    for (const k of [queryKeys.tasks.detail(7), sub, ['taskComments', 7, 'threads'], queryKeys.tasks.lists()])
      s.observe(k);
    await vi.runAllTimersAsync();
    s.fetched.length = 0;
    const applier = createChangeApplier(s.qc, () => 1);
    applier.apply([change({ entityType: 'task_comment', action: 'create', entityId: 50, actorId: 2 })]);
    await vi.runAllTimersAsync();
    expect(s.has(['taskComments', 7, 'threads'])).toBe(true);
    expect(s.has(queryKeys.tasks.lists())).toBe(true);
    expect(s.has(queryKeys.tasks.detail(7))).toBe(true);
    expect(s.has(sub)).toBe(false);
    applier.dispose();
    s.cleanup();
  });

  it('自己這個分頁剛寫入造成的回音：留言完全略過；任務只略過清單與詳情本身', async () => {
    const s = setup();
    const sub = [...queryKeys.tasks.detail(7), 'deps'];
    for (const k of [queryKeys.tasks.detail(7), sub, ['taskComments', 7, 'threads'], queryKeys.tasks.lists()])
      s.observe(k);
    await vi.runAllTimersAsync();
    s.fetched.length = 0;
    const applier = createChangeApplier(s.qc, () => 1);
    // 本分頁完成一次寫入
    await s.qc
      .getMutationCache()
      .build(s.qc, { mutationFn: () => Promise.resolve('ok') })
      .execute(undefined);

    applier.apply([change({ entityType: 'task_comment', action: 'create', entityId: 50, actorId: 1 })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.fetched).toEqual([]);

    applier.apply([change({ action: 'update', entityId: 7, actorId: 1 })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.has(queryKeys.tasks.lists())).toBe(false);
    expect(s.has(queryKeys.tasks.detail(7))).toBe(false);
    expect(s.has(sub)).toBe(true);

    // 超過回音時限：自己其他分頁的寫入照常重抓
    s.fetched.length = 0;
    await vi.advanceTimersByTimeAsync(ECHO_WINDOW_MS + 100);
    applier.apply([change({ entityType: 'task_comment', action: 'create', entityId: 51, actorId: 1 })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.has(['taskComments', 7, 'threads'])).toBe(true);
    expect(s.has(queryKeys.tasks.lists())).toBe(true);

    applier.dispose();
    s.cleanup();
  });

  it('同批中他人的變更優先：同一查詢鍵只要有一筆非回音就照常重抓', async () => {
    const s = setup();
    s.observe(queryKeys.tasks.lists());
    await vi.runAllTimersAsync();
    s.fetched.length = 0;
    const applier = createChangeApplier(s.qc, () => 1);
    await s.qc
      .getMutationCache()
      .build(s.qc, { mutationFn: () => Promise.resolve('ok') })
      .execute(undefined);
    applier.apply([
      change({ action: 'update', entityId: 7, actorId: 1 }),
      change({ action: 'update', entityId: 8, actorId: 2 }),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.has(queryKeys.tasks.lists())).toBe(true);
    applier.dispose();
    s.cleanup();
  });
});
