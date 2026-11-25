import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../shared/tasks.ts';
import { queryKeys } from './queryClient.ts';
import { findCachedTask, recordTaskUpdate } from './taskUndo.ts';
import { undoManager } from './undo.ts';

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 1,
    title: '寫報告',
    description: '',
    projectId: 1,
    statusId: 1,
    assigneeId: null,
    priority: 'none',
    startDate: null,
    dueDate: null,
    estimateHours: null,
    progress: 0,
    sortOrder: 1,
    custom: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Task;

describe('recordTaskUpdate', () => {
  beforeEach(() => undoManager.clear());

  it('1.5 秒內改過去又改回來（A→B→A）不留下空的復原', () => {
    const qc = new QueryClient();
    undoManager.push({ label: '更早的動作', undo: () => undefined, redo: () => undefined });
    recordTaskUpdate(qc, {
      id: 1,
      patch: { title: 'B' },
      before: task({ title: 'A' }),
      result: task({ title: 'B' }),
    });
    expect(undoManager.sizes().undo).toBe(2);
    recordTaskUpdate(qc, {
      id: 1,
      patch: { title: 'A' },
      before: task({ title: 'B' }),
      result: task({ title: 'A' }),
    });
    expect(undoManager.sizes().undo).toBe(1);
    expect(undoManager.getSnapshot().nextUndoLabel).toBe('更早的動作');
  });

  it('A→B→C 仍合併成一筆', () => {
    const qc = new QueryClient();
    for (const [from, to] of [
      ['A', 'B'],
      ['B', 'C'],
    ])
      recordTaskUpdate(qc, {
        id: 1,
        patch: { title: to },
        before: task({ title: from }),
        result: task({ title: to }),
      });
    expect(undoManager.sizes().undo).toBe(1);
  });

  it('handle 回填登記的項目 id', () => {
    const qc = new QueryClient();
    const handle = { id: null as number | null };
    recordTaskUpdate(qc, {
      id: 1,
      patch: { title: 'B' },
      before: task({ title: 'A' }),
      result: task({ title: 'B' }),
      option: { handle },
    });
    expect(handle.id).toBe(undoManager.topUndoId());
    expect(handle.id).not.toBeNull();
  });
});

describe('findCachedTask', () => {
  it('取各清單與詳情中 updatedAt 最新的一份（不取最早建立的過期篩選快取）', () => {
    const qc = new QueryClient();
    // 先建立的快取（舊篩選，不再更新）
    qc.setQueryData(queryKeys.tasks.list({ q: 'old' } as never), [task({ statusId: 1, updatedAt: 100 })]);
    qc.setQueryData(queryKeys.tasks.list({ q: 'now' } as never), [task({ statusId: 3, updatedAt: 200 })]);
    expect(findCachedTask(qc, 1)?.statusId).toBe(3);
  });
});
