import { useCallback, useSyncExternalStore } from 'react';
import { errorMessage } from './api.ts';
import { toast } from './toast.ts';

/*
 * 全站「復原 / 重做」（docs/design/undo.md）。
 * - 兩個堆疊（undo / redo），上限 50 筆；新動作清空 redo
 * - undo() / redo() 為 async：執行失敗不推進堆疊（由 onError 顯示錯誤）；回傳 'drop' 代表此筆已無法套用
 *   （例如任務已被別人刪除、使用者在衝突對話框選「略過這項」），從堆疊移除
 * - 同一 mergeKey 且在合併時限內的連續動作合併成一筆（保留最早的 undo、最新的 redo；可自訂 merge）
 * - 執行 undo / redo 期間的 push 一律忽略（避免復原自己觸發的寫入又被記錄）
 * - 純記憶體：重新整理即清空；登出時清空（lib/auth.ts）；只記錄自己的操作（SSE 的他人變更不會 push）
 */

/** 'drop'：這筆動作已無法套用（從堆疊移除，不移到另一個堆疊） */
export type UndoOutcome = void | 'drop';

export type UndoInput = {
  /** 中文描述，例如「修改『X』的標題」「刪除任務『X』」「把『X』移到『進行中』」 */
  label: string;
  undo: () => Promise<UndoOutcome> | UndoOutcome;
  redo: () => Promise<UndoOutcome> | UndoOutcome;
  /** 合併鍵：與堆疊頂端同鍵、且距上一次 push 不超過 mergeWindowMs 時合併為一筆 */
  mergeKey?: string;
  /** 合併時限（毫秒，預設 1500；同一次拖曳放下的多筆寫入可設 Infinity） */
  mergeWindowMs?: number;
  /** 自訂合併：回傳合併後的內容（預設保留舊的 undo、採用新的 label / redo） */
  merge?: (older: UndoEntry) => UndoInput;
  /** 附加資料（自訂 merge 時可讀取） */
  meta?: Record<string, unknown>;
};

export type UndoEntry = UndoInput & {
  id: number;
  /** 最後一次 push（含合併）的時間 */
  at: number;
  /** 已經被復原 / 重做過的項目不再與新動作合併 */
  sealed: boolean;
};

export type UndoKind = 'undo' | 'redo';

export type UndoRunResult =
  | { status: 'empty' | 'busy' }
  | { status: 'done' | 'dropped'; entry: UndoEntry }
  | { status: 'failed'; entry: UndoEntry; error: unknown };

export type UndoSnapshot = {
  canUndo: boolean;
  canRedo: boolean;
  nextUndoLabel: string | null;
  nextRedoLabel: string | null;
  busy: boolean;
};

export const UNDO_LIMIT = 50;
export const MERGE_WINDOW_MS = 1500;

export type UndoManagerOptions = {
  limit?: number;
  mergeWindowMs?: number;
  now?: () => number;
  onError?: (error: unknown, entry: UndoEntry, kind: UndoKind) => void;
};

export function createUndoManager({
  limit = UNDO_LIMIT,
  mergeWindowMs = MERGE_WINDOW_MS,
  now = Date.now,
  onError,
}: UndoManagerOptions = {}) {
  let undoStack: UndoEntry[] = [];
  let redoStack: UndoEntry[] = [];
  let busy = false;
  let seq = 0;
  const listeners = new Set<() => void>();

  const makeSnapshot = (): UndoSnapshot => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    nextUndoLabel: undoStack.at(-1)?.label ?? null,
    nextRedoLabel: redoStack.at(-1)?.label ?? null,
    busy,
  });
  let snapshot = makeSnapshot();
  const emit = () => {
    snapshot = makeSnapshot();
    listeners.forEach((fn) => fn());
  };

  function push(input: UndoInput): UndoEntry | null {
    if (busy) return null;
    const t = now();
    const top = undoStack.at(-1);
    redoStack = [];
    if (
      top &&
      !top.sealed &&
      input.mergeKey != null &&
      top.mergeKey === input.mergeKey &&
      t - top.at <= (input.mergeWindowMs ?? mergeWindowMs)
    ) {
      const merged = input.merge ? input.merge(top) : { ...input, undo: top.undo };
      const entry: UndoEntry = { ...merged, mergeKey: input.mergeKey, id: top.id, at: t, sealed: false };
      undoStack = [...undoStack.slice(0, -1), entry];
      emit();
      return entry;
    }
    const entry: UndoEntry = { ...input, id: ++seq, at: t, sealed: false };
    undoStack = [...undoStack, entry].slice(-limit);
    emit();
    return entry;
  }

  async function run(kind: UndoKind): Promise<UndoRunResult> {
    if (busy) return { status: 'busy' };
    const from = kind === 'undo' ? undoStack : redoStack;
    const entry = from.at(-1);
    if (!entry) return { status: 'empty' };
    busy = true;
    emit();
    try {
      const outcome = await (kind === 'undo' ? entry.undo() : entry.redo());
      const without = (list: UndoEntry[]) => list.filter((e) => e.id !== entry.id);
      undoStack = without(undoStack);
      redoStack = without(redoStack);
      if (outcome === 'drop') return { status: 'dropped', entry };
      const moved = { ...entry, sealed: true };
      if (kind === 'undo') redoStack = [...redoStack, moved].slice(-limit);
      else undoStack = [...undoStack, moved].slice(-limit);
      return { status: 'done', entry };
    } catch (error) {
      onError?.(error, entry, kind);
      return { status: 'failed', entry, error };
    } finally {
      busy = false;
      emit();
    }
  }

  return {
    push,
    undo: () => run('undo'),
    redo: () => run('redo'),
    /** 清空兩個堆疊（登出、切換使用者） */
    clear() {
      undoStack = [];
      redoStack = [];
      emit();
    },
    isBusy: () => busy,
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** 測試用 */
    sizes: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}

export type UndoManager = ReturnType<typeof createUndoManager>;

// ── 全站單例 ─────────────────────────────────────────

export const undoManager = createUndoManager({
  onError: (error, entry, kind) =>
    toast({
      tone: 'danger',
      title: `${kind === 'undo' ? '無法復原' : '無法重做'}：${entry.label}`,
      description: errorMessage(error),
    }),
});

/** 讓功能登記一筆可復原的動作（等同 undoManager.push）；在寫入「成功之後」呼叫 */
export function registerUndoable(input: UndoInput): void {
  undoManager.push(input);
}

/** 回傳 registerUndoable（給元件使用；參考穩定） */
export function useUndoable(): (input: UndoInput) => void {
  return useCallback((input: UndoInput) => registerUndoable(input), []);
}

export function useUndoState(): UndoSnapshot {
  return useSyncExternalStore(undoManager.subscribe, undoManager.getSnapshot, undoManager.getSnapshot);
}

const TOAST_KEY = 'undo-result';
const RESULT_TOAST_MS = 5000;

/** 執行復原 / 重做並顯示結果 toast（快捷鍵與頂欄按鈕共用） */
export async function performUndo(
  kind: UndoKind,
  manager: UndoManager = undoManager,
): Promise<UndoRunResult> {
  const res = await (kind === 'undo' ? manager.undo() : manager.redo());
  if (res.status === 'done') {
    const other: UndoKind = kind === 'undo' ? 'redo' : 'undo';
    toast({
      key: TOAST_KEY,
      tone: 'success',
      title: `${kind === 'undo' ? '已復原' : '已重做'}：${res.entry.label}`,
      // 同步回傳：先關閉這則，結果由下一則 toast 顯示
      action: {
        label: other === 'redo' ? '重做' : '復原',
        onClick: () => {
          void performUndo(other, manager);
        },
      },
      duration: RESULT_TOAST_MS,
    });
  }
  return res;
}
