import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { clearTaskFilters, parseTaskFilters, writeTaskFilters, type TaskFilters } from './filters.ts';

/**
 * 任務篩選狀態（完全由 URL 驅動）。各任務檢視以此取得條件，再交給 useTasks(filters)。
 * setFilters(patch, { replace })：下拉變更預設 push，搜尋輸入請傳 replace: true。
 */
export function useTaskFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const key = searchParams.toString();
  // 以字串為依賴，確保相同條件得到同一個物件（避免查詢鍵抖動）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filters = useMemo(() => parseTaskFilters(searchParams), [key]);

  const setFilters = useCallback(
    (patch: Partial<TaskFilters>, opts: { replace?: boolean } = {}) =>
      setSearchParams((prev) => writeTaskFilters(prev, patch), { replace: opts.replace }),
    [setSearchParams],
  );
  const clearFilters = useCallback(
    () => setSearchParams((prev) => clearTaskFilters(prev)),
    [setSearchParams],
  );
  return { filters, setFilters, clearFilters };
}
