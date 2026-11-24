import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api.ts';
import type { TaskFilters } from './filters.ts';

/** 清單類查詢的輪詢間隔（基線多人可見性；T9 接上 SSE 後可放寬） */
export const LIST_POLL_MS = 30_000;

/**
 * 全站共用 QueryClient：
 * - 視窗 focus 重抓（focus 時靜默更新，不顯示全頁載入）
 * - 清單類 hooks 另設 refetchInterval = LIST_POLL_MS
 * - 4xx 不重試；網路錯誤最多重試 2 次
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchIntervalInBackground: false,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();

/** 查詢鍵集中定義；各軌道自己的查詢以 feature 名稱開頭（如 ['feedback', ...]） */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  tasks: {
    all: ['tasks'] as const,
    lists: () => ['tasks', 'list'] as const,
    list: (filters: TaskFilters) => ['tasks', 'list', filters] as const,
    detail: (id: number) => ['tasks', 'detail', id] as const,
  },
  users: ['users'] as const,
  projects: ['projects'] as const,
  statuses: ['statuses'] as const,
  properties: ['properties'] as const,
};
