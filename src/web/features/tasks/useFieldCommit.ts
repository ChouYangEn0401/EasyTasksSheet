import { useCallback } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useOptimisticUpdate } from './data.ts';
import { getValue, toPatch, type ColumnDef } from './model.ts';

export type CommitResult = { ok: true } | { ok: false; error: string } | { ok: true; skipped: true };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 提交單一欄位（List 儲存格與 Drawer 共用）：值未變則略過；PATCH 只送該欄位，樂觀更新、失敗回復。
 * 每次呼叫各自回傳 promise（可同時編輯多格）。
 */
export function useFieldCommit() {
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  return useCallback(
    async (task: Task, col: Pick<ColumnDef, 'kind' | 'property'>, value: unknown): Promise<CommitResult> => {
      if (same(getValue(task, col), value)) return { ok: true, skipped: true };
      try {
        await update.mutateAsync({ id: task.id, patch: toPatch(col, value), userId: me?.id });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    // update.mutateAsync 為穩定參考
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update.mutateAsync, me?.id],
  );
}
