import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '../../../shared/overview.ts';
import { api } from '../../lib/api.ts';
import { LIST_POLL_MS } from '../../lib/queryClient.ts';

export const overviewKey = ['overview'] as const;

/** GET /api/overview；沿用 30 秒輪詢與 focus 重抓，靜默更新 */
export function useOverview() {
  return useQuery({
    queryKey: overviewKey,
    queryFn: ({ signal }) => api.get<OverviewResponse>('/overview', { signal }),
    refetchInterval: LIST_POLL_MS,
    placeholderData: (prev) => prev,
  });
}

/** 24 → 24h；1.5 → 1.5h */
export function formatHours(n: number): string {
  return `${Math.round(n * 10) / 10}h`;
}

/** 11/23–11/29 */
export function formatWeekRange(r: { start: string; end: string }): string {
  const f = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${f(r.start)}–${f(r.end)}`;
}

/** 純日期 → 11/28 */
export const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
