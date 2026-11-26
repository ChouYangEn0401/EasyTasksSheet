import { useCallback } from 'preact/compat';

import { errorMessage } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useOptimisticUpdate } from './data.js';
import { getValue, toPatch } from './model.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 提交單一欄位（List 儲存格與 Drawer 共用）：值未變則略過；PATCH 只送該欄位，樂觀更新、失敗回復。
 * 每次呼叫各自回傳 promise（可同時編輯多格）。
 */
export function useFieldCommit() {
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  return useCallback(
    async (task, col, value) => {
      if (same(getValue(task, col), value)) return { ok: true, skipped: true };
      try {
        await update.mutateAsync({ id: task.id, patch: toPatch(col, value), userId: me?.id });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    // update.mutateAsync 為穩定參考

    [update.mutateAsync, me?.id],
  );
}
