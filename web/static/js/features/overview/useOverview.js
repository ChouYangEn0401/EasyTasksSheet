import { useQuery } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { LIST_POLL_MS } from '../../lib/queryClient.js';
import { withSortedMembers } from './sortMembers.js';

export const overviewKey = ['overview'];

/** GET /api/overview；沿用 30 秒輪詢與 focus 重抓，靜默更新。成員在同條件間依名稱（zh-Hant）重排 */
export function useOverview() {
  return useQuery({
    queryKey: overviewKey,
    queryFn: ({ signal }) => api.get('/overview', { signal }),
    select: withSortedMembers,
    refetchInterval: LIST_POLL_MS,
    placeholderData: (prev) => prev,
  });
}

/** GET /api/overview/activity?weeks=3（近三週）；key 在 ['overview'] 之下，任務變動時一併失效重抓 */
export function useOverviewActivity() {
  return useQuery({
    queryKey: [...overviewKey, 'activity', 3],
    queryFn: ({ signal }) => api.get('/overview/activity?weeks=3', { signal }),
    refetchInterval: LIST_POLL_MS,
    placeholderData: (prev) => prev,
  });
}

/** 24 → 24h；1.5 → 1.5h */
export function formatHours(n) {
  return `${Math.round(n * 10) / 10}h`;
}

/** 11/23–11/29 */
export function formatWeekRange(r) {
  const f = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${f(r.start)}–${f(r.end)}`;
}

/** 純日期 → 11/28 */
export const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
