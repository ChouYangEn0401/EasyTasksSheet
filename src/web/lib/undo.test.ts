import { describe, expect, it, vi } from 'vitest';
import { createUndoManager, type UndoInput } from './undo.ts';

function setup(opts: { limit?: number } = {}) {
  let t = 1000;
  const onError = vi.fn();
  const m = createUndoManager({ now: () => t, onError, ...opts });
  return {
    m,
    onError,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 記錄執行順序的動作 */
function action(log: string[], name: string, extra: Partial<UndoInput> = {}): UndoInput {
  return {
    label: name,
    undo: () => {
      log.push(`undo:${name}`);
    },
    redo: () => {
      log.push(`redo:${name}`);
    },
    ...extra,
  };
}

describe('UndoManager', () => {
  it('push / undo / redo 依序移動於兩個堆疊', async () => {
    const { m } = setup();
    const log: string[] = [];
    m.push(action(log, 'A'));
    m.push(action(log, 'B'));
    expect(m.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, nextUndoLabel: 'B' });

    expect((await m.undo()).status).toBe('done');
    expect(m.getSnapshot()).toMatchObject({ nextUndoLabel: 'A', nextRedoLabel: 'B', canRedo: true });
    await m.undo();
    expect(m.getSnapshot()).toMatchObject({ canUndo: false, nextRedoLabel: 'A' });
    expect((await m.undo()).status).toBe('empty');

    await m.redo();
    expect(m.getSnapshot()).toMatchObject({ nextUndoLabel: 'A', nextRedoLabel: 'B' });
    await m.redo();
    expect(log).toEqual(['undo:B', 'undo:A', 'redo:A', 'redo:B']);
    expect(m.sizes()).toEqual({ undo: 2, redo: 0 });
  });

  it('新動作清空 redo 堆疊', async () => {
    const { m } = setup();
    const log: string[] = [];
    m.push(action(log, 'A'));
    await m.undo();
    expect(m.getSnapshot().canRedo).toBe(true);
    m.push(action(log, 'B'));
    expect(m.getSnapshot()).toMatchObject({ canRedo: false, nextUndoLabel: 'B' });
  });

  it('上限 50 筆：超過時捨棄最舊的', () => {
    const { m } = setup();
    for (let i = 0; i < 55; i++) m.push(action([], `#${i}`));
    expect(m.sizes().undo).toBe(50);
    expect(m.getSnapshot().nextUndoLabel).toBe('#54');
  });

  it('同 mergeKey 且在時限內合併：保留最早的 undo、最新的 redo', async () => {
    const { m, advance } = setup();
    const log: string[] = [];
    m.push(action(log, '第一次', { mergeKey: 'task:1:title' }));
    advance(1000);
    m.push(action(log, '第二次', { mergeKey: 'task:1:title' }));
    expect(m.sizes().undo).toBe(1);
    expect(m.getSnapshot().nextUndoLabel).toBe('第二次');
    await m.undo();
    await m.redo();
    expect(log).toEqual(['undo:第一次', 'redo:第二次']);
  });

  it('超過合併時限、不同 mergeKey 或已復原過的項目不合併', async () => {
    const { m, advance } = setup();
    m.push(action([], 'A', { mergeKey: 'k' }));
    advance(1501);
    m.push(action([], 'B', { mergeKey: 'k' }));
    expect(m.sizes().undo).toBe(2);
    m.push(action([], 'C', { mergeKey: 'other' }));
    expect(m.sizes().undo).toBe(3);
    // 復原後再重做的項目不再與新動作合併
    await m.undo();
    await m.redo();
    m.push(action([], 'D', { mergeKey: 'other' }));
    expect(m.sizes().undo).toBe(4);
  });

  it('mergeWindowMs = Infinity（同一次拖曳的多筆寫入）一律合併；可自訂 merge', () => {
    const { m, advance } = setup();
    m.push({ ...action([], 'drop'), mergeKey: 'g', mergeWindowMs: Infinity, meta: { n: 1 } });
    advance(60_000);
    m.push({
      ...action([], 'drop'),
      mergeKey: 'g',
      mergeWindowMs: Infinity,
      merge: (older) => ({ ...action([], `合併 ${Number(older.meta?.n) + 1}`), meta: { n: 2 } }),
    });
    expect(m.sizes().undo).toBe(1);
    expect(m.getSnapshot().nextUndoLabel).toBe('合併 2');
  });

  it('執行失敗不推進堆疊，並呼叫 onError', async () => {
    const { m, onError } = setup();
    const err = new Error('網路錯誤');
    m.push({
      label: 'A',
      undo: () => Promise.reject(err),
      redo: () => undefined,
    });
    const res = await m.undo();
    expect(res.status).toBe('failed');
    expect(onError).toHaveBeenCalledWith(err, expect.objectContaining({ label: 'A' }), 'undo');
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    expect(m.getSnapshot().busy).toBe(false);
  });

  it("回傳 'drop' 時從堆疊移除（例如任務已被刪除）", async () => {
    const { m } = setup();
    m.push(action([], 'A'));
    m.push({ label: 'B', undo: () => 'drop', redo: () => undefined });
    expect((await m.undo()).status).toBe('dropped');
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    expect(m.getSnapshot().nextUndoLabel).toBe('A');
  });

  it('執行中忽略新的 push 與重複的 undo（避免遞迴記錄）', async () => {
    const { m } = setup();
    let release!: () => void;
    m.push({
      label: 'A',
      undo: () =>
        new Promise<void>((r) => {
          release = r;
        }),
      redo: () => undefined,
    });
    const running = m.undo();
    expect(m.getSnapshot().busy).toBe(true);
    expect(m.push(action([], '復原觸發的寫入'))).toBeNull();
    expect((await m.undo()).status).toBe('busy');
    release();
    await running;
    expect(m.sizes()).toEqual({ undo: 0, redo: 1 });
  });

  it('clear（登出）清空兩個堆疊並通知訂閱者', async () => {
    const { m } = setup();
    const fn = vi.fn();
    m.subscribe(fn);
    m.push(action([], 'A'));
    m.push(action([], 'B'));
    await m.undo();
    m.clear();
    expect(m.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, nextUndoLabel: null });
    expect(fn).toHaveBeenCalled();
  });
});
