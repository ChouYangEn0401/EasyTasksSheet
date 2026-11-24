import { MutationCache, QueryClient, type Mutation } from '@tanstack/react-query';
import { ApiError } from './api.ts';
import { notifyError, type MutationToastMeta } from './errorToast.ts';
import type { TaskFilters } from './filters.ts';

/** 清單類查詢的輪詢間隔（即時連線中斷時的後備；SSE 連線正常時由 lib/sync.ts 停用） */
export const LIST_POLL_MS = 30_000;

type AnyMutation = Mutation<unknown, unknown, unknown, unknown>;

/** 以相同參數重送一次（重新執行樂觀更新與回呼；再次失敗會再發 toast） */
function retryMutation(client: QueryClient, mutation: AnyMutation, variables: unknown): Promise<unknown> {
  return client
    .getMutationCache()
    .build(client, mutation.options)
    .execute(variables)
    .catch(() => undefined);
}

/**
 * 全站共用 QueryClient：
 * - 視窗 focus 重抓（focus 時靜默更新，不顯示全頁載入）
 * - 清單類 hooks 另設 refetchInterval = LIST_POLL_MS
 * - 4xx 不重試；網路錯誤最多重試 2 次
 * - 寫入失敗一律發 toast（mutation meta.errorToast = false 者除外），並在畫面回復後才出現
 */
export function createQueryClient() {
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (err, variables, _ctx, mutation) => {
        if ((mutation.meta as MutationToastMeta | undefined)?.errorToast === false) return;
        // 先讓 mutation 自己的 onError（樂觀更新回復）執行，再出現 toast
        setTimeout(() => {
          notifyError(err, () => retryMutation(client, mutation as AnyMutation, variables));
          if (err instanceof ApiError && err.status === 404) void client.invalidateQueries();
        }, 0);
      },
    }),
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
  return client;
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
