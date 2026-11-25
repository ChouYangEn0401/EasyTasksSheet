import { useCallback, useSyncExternalStore } from 'react';
import { ApiError, errorMessage } from './api.ts';
import { toast } from './toast.ts';

/*
 * 全站「復原 / 重做」（docs/design/undo.md）。
 * - 兩個堆疊（undo / redo），上限 50 筆；新動作清空 redo
 * - undo() / redo() 為 async；回傳 'drop' 代表此筆已無法套用
 *   （例如任務已被別人刪除、使用者在衝突對話框選「略過這項」），從堆疊移除
 * - 執行失敗：暫時性錯誤（網路、5xx、401 / 408 / 429）不推進堆疊（可重試）；
 *   永久性錯誤（其餘 4xx，例如描述已被管理者鎖定）視同 'drop'，移除該筆並提示，避免堆疊卡死
 * - 同一 mergeKey 且在合併時限內的連續動作合併成一筆（保留最早的 undo、最新的 redo；可自訂 merge）；
 *   合併後沒有實際變更（A→B→A，merge 回傳 noop: true）則把該筆移出堆疊
 * - 執行 undo / redo 期間，其他寫入照常登記（不會與執行中的那筆合併）；
 *   復原 / 重做本身的寫入不登記（各功能以 api 直接呼叫或 undo: false 執行，不經過登記路徑）
 * - toast 上的「復原」以 undoEntry(id) 執行指定項目：在頂端走正常流程；不在頂端則執行後從堆疊移除
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
  /** 合併後已無實際變更（A→B→A）：由 merge 回傳 true，該筆移出堆疊 */
  noop?: boolean;
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
  /** 永久性失敗：已從堆疊移除 */
  | { status: 'rejected'; entry: UndoEntry; error: unknown }
  /** 暫時性失敗：留在堆疊，可重試 */
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

/** 永久性錯誤（重試也不會成功）：4xx，但 401（重新登入後可再試）、408、429 除外 */
export function isPermanentUndoError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export type UndoManagerOptions = {
  limit?: number;
  mergeWindowMs?: number;
  now?: () => number;
  /** permanent = true 時該筆已從堆疊移除 */
  onError?: (error: unknown, entry: UndoEntry, kind: UndoKind, permanent: boolean) => void;
  isPermanentError?: (error: unknown) => boolean;
};

export function createUndoManager({
  limit = UNDO_LIMIT,
  mergeWindowMs = MERGE_WINDOW_MS,
  now = Date.now,
  onError,
  isPermanentError = isPermanentUndoError,
}: UndoManagerOptions = {}) {
  let undoStack: UndoEntry[] = [];
  let redoStack: UndoEntry[] = [];
  let busy = false;
  /** 執行中的那筆（新動作不與它合併） */
  let runningId: number | null = null;
  /** 執行期間有新動作登記：完成後不再放進 redo（新動作會清空 redo） */
  let pushedDuringRun = false;
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
  const without = (list: UndoEntry[], id: number) => list.filter((e) => e.id !== id);
  const removeEverywhere = (id: number) => {
    undoStack = without(undoStack, id);
    redoStack = without(redoStack, id);
  };

  function push(input: UndoInput): UndoEntry | null {
    const t = now();
    const top = undoStack.at(-1);
    redoStack = [];
    if (busy) pushedDuringRun = true;
    if (
      top &&
      !top.sealed &&
      top.id !== runningId &&
      input.mergeKey != null &&
      top.mergeKey === input.mergeKey &&
      t - top.at <= (input.mergeWindowMs ?? mergeWindowMs)
    ) {
      const merged = input.merge ? input.merge(top) : { ...input, undo: top.undo };
      if (merged.noop) {
        undoStack = undoStack.slice(0, -1);
        emit();
        return null;
      }
      const entry: UndoEntry = { ...merged, mergeKey: input.mergeKey, id: top.id, at: t, sealed: false };
      undoStack = [...undoStack.slice(0, -1), entry];
      emit();
      return entry;
    }
    if (input.noop) {
      emit();
      return null;
    }
    const entry: UndoEntry = { ...input, id: ++seq, at: t, sealed: false };
    undoStack = [...undoStack, entry].slice(-limit);
    emit();
    return entry;
  }

  /** 執行一筆；inPlace = true 表示它在堆疊頂端（成功後移到另一個堆疊），否則成功後直接移除 */
  async function execute(entry: UndoEntry, kind: UndoKind, inPlace: boolean): Promise<UndoRunResult> {
    busy = true;
    runningId = entry.id;
    pushedDuringRun = false;
    emit();
    try {
      const outcome = await (kind === 'undo' ? entry.undo() : entry.redo());
      removeEverywhere(entry.id);
      if (outcome === 'drop') return { status: 'dropped', entry };
      if (inPlace) {
        const moved = { ...entry, sealed: true };
        if (kind === 'undo') {
          if (!pushedDuringRun) redoStack = [...redoStack, moved].slice(-limit);
        } else undoStack = [...undoStack, moved].slice(-limit);
      }
      return { status: 'done', entry };
    } catch (error) {
      const permanent = isPermanentError(error);
      if (permanent) removeEverywhere(entry.id);
      onError?.(error, entry, kind, permanent);
      return permanent ? { status: 'rejected', entry, error } : { status: 'failed', entry, error };
    } finally {
      busy = false;
      runningId = null;
      pushedDuringRun = false;
      emit();
    }
  }

  async function run(kind: UndoKind): Promise<UndoRunResult> {
    if (busy) return { status: 'busy' };
    const entry = (kind === 'undo' ? undoStack : redoStack).at(-1);
    if (!entry) return { status: 'empty' };
    return execute(entry, kind, true);
  }

  /**
   * 復原指定的一筆（toast 上的「復原」）：在頂端 = 一般復原（之後可重做）；
   * 不在頂端 = 執行後從堆疊移除（避免之後 Ctrl+Z 再執行一次）；已不在復原堆疊（已復原過）= 不做事。
   */
  async function undoEntry(id: number): Promise<UndoRunResult> {
    if (busy) return { status: 'busy' };
    const entry = undoStack.find((e) => e.id === id);
    if (!entry) return { status: 'empty' };
    return execute(entry, 'undo', undoStack.at(-1)?.id === id);
  }

  return {
    push,
    undo: () => run('undo'),
    redo: () => run('redo'),
    undoEntry,
    /** 清空兩個堆疊（登出、切換使用者） */
    clear() {
      undoStack = [];
      redoStack = [];
      emit();
    },
    isBusy: () => busy,
    topUndoId: () => undoStack.at(-1)?.id ?? null,
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
  onError: (error, entry, kind, permanent) =>
    toast({
      tone: 'danger',
      title: permanent
        ? `${kind === 'undo' ? '無法復原' : '無法重做'}，已從復原紀錄移除：${entry.label}`
        : `${kind === 'undo' ? '無法復原' : '無法重做'}：${entry.label}`,
      description: errorMessage(error),
    }),
});

/** 讓功能登記一筆可復原的動作（等同 undoManager.push）；在寫入「成功之後」呼叫。回傳項目 id（未入堆疊為 null） */
export function registerUndoable(input: UndoInput): number | null {
  return undoManager.push(input)?.id ?? null;
}

/** 回傳 registerUndoable（給元件使用；參考穩定） */
export function useUndoable(): (input: UndoInput) => number | null {
  return useCallback((input: UndoInput) => registerUndoable(input), []);
}

export function useUndoState(): UndoSnapshot {
  return useSyncExternalStore(undoManager.subscribe, undoManager.getSnapshot, undoManager.getSnapshot);
}

const TOAST_KEY = 'undo-result';
const RESULT_TOAST_MS = 5000;

function showResult(kind: UndoKind, res: UndoRunResult, manager: UndoManager, canFlip: boolean) {
  if (res.status !== 'done') return;
  const other: UndoKind = kind === 'undo' ? 'redo' : 'undo';
  toast({
    key: TOAST_KEY,
    tone: 'success',
    title: `${kind === 'undo' ? '已復原' : '已重做'}：${res.entry.label}`,
    // 同步回傳：先關閉這則，結果由下一則 toast 顯示
    action: canFlip
      ? {
          label: other === 'redo' ? '重做' : '復原',
          onClick: () => {
            void performUndo(other, manager);
          },
        }
      : undefined,
    duration: RESULT_TOAST_MS,
  });
}

/** 執行復原 / 重做並顯示結果 toast（快捷鍵與頂欄按鈕共用） */
export async function performUndo(
  kind: UndoKind,
  manager: UndoManager = undoManager,
): Promise<UndoRunResult> {
  const res = await (kind === 'undo' ? manager.undo() : manager.redo());
  showResult(kind, res, manager, true);
  return res;
}

/**
 * toast 上的「復原」：執行 registerUndoable 回傳的那一筆（不論是否在頂端），錯誤照常提示。
 * id 為 null（未入堆疊）時不做事。
 */
export async function performUndoEntry(
  id: number | null,
  manager: UndoManager = undoManager,
): Promise<UndoRunResult> {
  if (id == null) return { status: 'empty' };
  const wasTop = manager.topUndoId() === id;
  const res = await manager.undoEntry(id);
  // 在頂端時走正常流程（之後可重做）；不在頂端則已從堆疊移除，不提供重做
  showResult('undo', res, manager, wasTop);
  return res;
}
