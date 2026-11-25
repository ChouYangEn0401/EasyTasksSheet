import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import { createUndoManager, isPermanentUndoError, type UndoInput } from './undo.ts';

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

  it('暫時性失敗（網路、5xx、401、408、429）不推進堆疊，並呼叫 onError', async () => {
    for (const err of [
      new Error('網路錯誤'),
      new ApiError(0, 'NETWORK_ERROR', '無法連線'),
      new ApiError(500, 'INTERNAL', '伺服器錯誤'),
      new ApiError(401, 'UNAUTHORIZED', '請重新登入'),
      new ApiError(408, 'TIMEOUT', '逾時'),
      new ApiError(429, 'RATE_LIMITED', '太頻繁'),
    ]) {
      const { m, onError } = setup();
      m.push({
        label: 'A',
        undo: () => Promise.reject(err),
        redo: () => undefined,
      });
      const res = await m.undo();
      expect(res.status).toBe('failed');
      expect(onError).toHaveBeenCalledWith(err, expect.objectContaining({ label: 'A' }), 'undo', false);
      expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
      expect(m.getSnapshot().busy).toBe(false);
    }
  });

  it('永久性失敗（其他 4xx，例如描述已被鎖定）移除該筆，之後可復原更早的動作', async () => {
    const { m, onError } = setup();
    const log: string[] = [];
    m.push(action(log, '新增待辦項目'));
    const err = new ApiError(403, 'DESCRIPTION_LOCKED', '描述已由管理者鎖定');
    m.push({ label: '修改描述', undo: () => Promise.reject(err), redo: () => undefined });
    const res = await m.undo();
    expect(res.status).toBe('rejected');
    expect(onError).toHaveBeenCalledWith(err, expect.objectContaining({ label: '修改描述' }), 'undo', true);
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    expect(m.getSnapshot().nextUndoLabel).toBe('新增待辦項目');
    expect((await m.undo()).status).toBe('done');
    expect(log).toEqual(['undo:新增待辦項目']);
  });

  it('isPermanentUndoError：只把 401 / 408 / 429 以外的 4xx 視為永久性', () => {
    expect(isPermanentUndoError(new ApiError(403, 'X', ''))).toBe(true);
    expect(isPermanentUndoError(new ApiError(409, 'X', ''))).toBe(true);
    expect(isPermanentUndoError(new ApiError(422, 'X', ''))).toBe(true);
    expect(isPermanentUndoError(new ApiError(401, 'X', ''))).toBe(false);
    expect(isPermanentUndoError(new ApiError(429, 'X', ''))).toBe(false);
    expect(isPermanentUndoError(new ApiError(503, 'X', ''))).toBe(false);
    expect(isPermanentUndoError(new Error('x'))).toBe(false);
  });

  it('合併後回到原值（A→B→A，merge 回傳 noop）時移出堆疊', () => {
    const { m, advance } = setup();
    m.push(action([], '更早的動作'));
    const toggle = (from: boolean, to: boolean): UndoInput => ({
      ...action([], `改成 ${String(to)}`),
      mergeKey: 'checklist:1:done',
      meta: { from, to },
      merge: (older) => ({
        ...action([], `改成 ${String(to)}`),
        meta: { from: older.meta?.from, to },
        noop: older.meta?.from === to,
      }),
    });
    m.push(toggle(false, true));
    advance(500);
    expect(m.push(toggle(true, false))).toBeNull();
    expect(m.sizes().undo).toBe(1);
    expect(m.getSnapshot().nextUndoLabel).toBe('更早的動作');
  });

  it('undoEntry：在頂端走一般流程（可重做）', async () => {
    const { m } = setup();
    const log: string[] = [];
    const a = m.push(action(log, 'A'))!;
    expect((await m.undoEntry(a.id)).status).toBe('done');
    expect(m.sizes()).toEqual({ undo: 0, redo: 1 });
    // 已復原過：再按一次 toast 的「復原」不會重複執行
    expect((await m.undoEntry(a.id)).status).toBe('empty');
    expect(log).toEqual(['undo:A']);
  });

  it('undoEntry：不在頂端時執行後從堆疊移除，之後 Ctrl+Z 不再重複執行', async () => {
    const { m } = setup();
    const log: string[] = [];
    const a = m.push(action(log, 'A'))!;
    m.push(action(log, 'B'));
    expect((await m.undoEntry(a.id)).status).toBe('done');
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    await m.undo();
    expect((await m.undo()).status).toBe('empty');
    expect(log).toEqual(['undo:A', 'undo:B']);
  });

  it('undoEntry：不在頂端且暫時性失敗時保留，永久性失敗時移除', async () => {
    const { m, onError } = setup();
    let err: unknown = new ApiError(503, 'X', '暫停服務');
    const a = m.push({ label: 'A', undo: () => Promise.reject(err), redo: () => undefined })!;
    m.push(action([], 'B'));
    expect((await m.undoEntry(a.id)).status).toBe('failed');
    expect(m.sizes().undo).toBe(2);
    err = new ApiError(403, 'X', '沒有權限');
    expect((await m.undoEntry(a.id)).status).toBe('rejected');
    expect(m.sizes().undo).toBe(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("回傳 'drop' 時從堆疊移除（例如任務已被刪除）", async () => {
    const { m } = setup();
    m.push(action([], 'A'));
    m.push({ label: 'B', undo: () => 'drop', redo: () => undefined });
    expect((await m.undo()).status).toBe('dropped');
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    expect(m.getSnapshot().nextUndoLabel).toBe('A');
  });

  it('執行中忽略重複的 undo；執行中完成的其他寫入照常登記（不與執行中的那筆合併）', async () => {
    const { m } = setup();
    let release!: () => void;
    m.push({
      label: 'A',
      mergeKey: 'k',
      undo: () =>
        new Promise<void>((r) => {
          release = r;
        }),
      redo: () => undefined,
    });
    const running = m.undo();
    expect(m.getSnapshot().busy).toBe(true);
    expect((await m.undo()).status).toBe('busy');
    expect(m.push(action([], '其他寫入', { mergeKey: 'k' }))).not.toBeNull();
    release();
    await running;
    // A 已復原並離開堆疊；新動作留在復原堆疊，且新動作清空 redo（A 不進 redo）
    expect(m.sizes()).toEqual({ undo: 1, redo: 0 });
    expect(m.getSnapshot().nextUndoLabel).toBe('其他寫入');
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
