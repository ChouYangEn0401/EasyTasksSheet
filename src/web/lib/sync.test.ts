import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Change } from '../../shared/sync.ts';
import { queryKeys } from './queryClient.ts';
import { createChangeApplier, isTaskDetailOf } from './sync.ts';

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
  it('只比對指定 id 的任務詳情查詢', () => {
    const ids = new Set([7]);
    expect(isTaskDetailOf(queryKeys.tasks.detail(7), ids)).toBe(true);
    expect(isTaskDetailOf(queryKeys.tasks.detail(8), ids)).toBe(false);
    expect(isTaskDetailOf(queryKeys.tasks.lists(), ids)).toBe(false);
    expect(isTaskDetailOf(['feedback', 'detail', 7], ids)).toBe(false);
  });
});

describe('createChangeApplier', () => {
  afterEach(() => vi.useRealTimers());

  it('任務刪除事件不重抓該任務仍有觀察者的詳情查詢（避免 404），其他查詢照常重抓', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const fetched: string[] = [];
    const observe = (key: readonly unknown[]) => {
      const obs = new QueryObserver(qc, {
        queryKey: key,
        queryFn: () => {
          fetched.push(JSON.stringify(key));
          return 'x';
        },
      });
      return obs.subscribe(() => {});
    };
    const unsubs = [
      observe(queryKeys.tasks.detail(7)),
      observe(queryKeys.tasks.detail(8)),
      observe(queryKeys.tasks.lists()),
    ];
    await vi.runAllTimersAsync();
    fetched.length = 0;

    const applier = createChangeApplier(qc, () => 1);
    applier.apply([change({ action: 'delete', entityId: 7 })]);
    await vi.runAllTimersAsync();

    expect(fetched).not.toContain(JSON.stringify(queryKeys.tasks.detail(7)));
    expect(fetched).toContain(JSON.stringify(queryKeys.tasks.detail(8)));
    expect(fetched).toContain(JSON.stringify(queryKeys.tasks.lists()));

    // 刪除紀錄只作用於當批 flush，之後的更新事件照常重抓
    fetched.length = 0;
    applier.apply([change({ action: 'update', entityId: 8 })]);
    await vi.runAllTimersAsync();
    expect(fetched).toContain(JSON.stringify(queryKeys.tasks.detail(8)));

    applier.dispose();
    unsubs.forEach((u) => u());
    qc.clear();
  });
});
