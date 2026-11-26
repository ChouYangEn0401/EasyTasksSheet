import { useMutation, useQuery, useQueryClient } from '../../lib/query.js';

import { api } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { LIST_POLL_MS, queryKeys } from '../../lib/queryClient.js';
import { recordTodoCreate, recordTodoDelete, recordTodoUpdate } from '../undo/simpleUndo.js';

/** 個人清單的查詢鍵：皆以成員 id 區分（檢視他人時使用他人 id） */
export const personalKeys = {
  all: ['personal'],
  todos: (userId) => ['personal', 'todos', userId],
  pins: (userId) => ['personal', 'pins', userId],
};

const userQuery = (userId, me) => (userId === me ? '' : `?user=${userId}`);

/** 某成員的自由待辦（依 sortOrder 遞增） */
export function useTodos(userId) {
  const me = useCurrentUser()?.id;
  return useQuery({
    queryKey: personalKeys.todos(userId),
    queryFn: ({ signal }) => api.get(`/personal${userQuery(userId, me)}`, { signal }),
    refetchInterval: LIST_POLL_MS,
    enabled: me != null,
  });
}

/** 某成員標記的任務（依標記時間新→舊）；PinButton 以登入者 id 共用同一個查詢 */
export function usePins(userId) {
  const me = useCurrentUser()?.id;
  return useQuery({
    queryKey: personalKeys.pins(userId ?? 0),
    queryFn: ({ signal }) => api.get(`/personal/pins${userQuery(userId, me)}`, { signal }),
    refetchInterval: LIST_POLL_MS,
    enabled: me != null && userId != null,
  });
}

/** 匯報報告：某成員在 from~to（含頭尾日）的完成事項；extra 為 include 項目（doing / deferred / cancelled / created） */
export function useReport(userId, range, include, enabled) {
  const me = useCurrentUser()?.id;
  const inc = include.join(',');
  return useQuery({
    queryKey: [...personalKeys.all, 'report', userId, range.from, range.to, inc],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ from: range.from, to: range.to });
      if (userId !== me) q.set('user', String(userId));
      if (inc) q.set('include', inc);
      return api.get(`/personal/report?${q}`, { signal });
    },
    enabled: enabled && me != null,
    staleTime: 0,
  });
}

/* ── 自由待辦寫入（皆只能改自己的清單） ─────────────────────── */

function useMyTodoKey() {
  return personalKeys.todos(useCurrentUser()?.id ?? 0);
}

export function useCreateTodo() {
  const qc = useQueryClient();
  const key = useMyTodoKey();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (input) => api.post('/personal', input),
    onSuccess: (item) => {
      qc.setQueryData(key, (prev) => [item, ...(prev ?? [])]);
      recordTodoCreate(qc, key, item);
      return qc.invalidateQueries({ queryKey: key });
    },
  });
}

const bySort = (a, b) => a.sortOrder - b.sortOrder || a.id - b.id;

/** 樂觀套用 PATCH：與後端一致，status 與 isDone 保持同步 */
export function applyPatch(item, patch) {
  const next = { ...item, ...patch };
  if (patch.status !== undefined) next.isDone = patch.status === 'done';
  else if (patch.isDone !== undefined) {
    if (patch.isDone) next.status = 'done';
    else if (item.status === 'done') next.status = 'todo';
  }
  return next;
}

/** PATCH：樂觀更新，失敗還原（錯誤由呼叫端顯示） */
export function useUpdateTodo() {
  const qc = useQueryClient();
  const key = useMyTodoKey();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: ({ id, ...patch }) => api.patch(`/personal/${id}`, patch),
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (list) => list?.map((i) => (i.id === id ? applyPatch(i, patch) : i)).sort(bySort));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (item, { id: _id, ...patch }, ctx) => {
      qc.setQueryData(key, (list) => list?.map((i) => (i.id === item.id ? item : i)).sort(bySort));
      recordTodoUpdate(
        qc,
        key,
        ctx?.prev?.find((i) => i.id === item.id),
        patch,
        item,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteTodo() {
  const qc = useQueryClient();
  const key = useMyTodoKey();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: (id) => api.delete(`/personal/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (list) => list?.filter((i) => i.id !== id));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (_res, id, ctx) => {
      const item = ctx?.prev?.find((i) => i.id === id);
      if (item) recordTodoDelete(qc, key, item);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useClearDoneTodos() {
  const qc = useQueryClient();
  const key = useMyTodoKey();
  return useMutation({
    // 表單 / 頁面自行顯示失敗訊息，不發全域失敗 toast
    meta: { errorToast: false },
    mutationFn: () => api.delete('/personal/done'),
    onSuccess: () => {
      qc.setQueryData(key, (list) => list?.filter((i) => i.status !== 'done'));
      return qc.invalidateQueries({ queryKey: key });
    },
  });
}

/* ── 標記 ─────────────────────── */

/** 從任何已載入的任務查詢中找出任務（樂觀加入「我標記的」用） */
function findCachedTask(qc, taskId) {
  const detail = qc.getQueryData(queryKeys.tasks.detail(taskId));
  if (detail) return detail;
  for (const [, data] of qc.getQueriesData({ queryKey: queryKeys.tasks.all })) {
    if (Array.isArray(data)) {
      const t = data.find((x) => x.id === taskId);
      if (t) return t;
    }
  }
  for (const [, data] of qc.getQueriesData({ queryKey: personalKeys.all })) {
    if (Array.isArray(data)) {
      const p = data.find((x) => x && typeof x === 'object' && 'task' in x && x.task.id === taskId);
      if (p) return p.task;
    }
  }
  return undefined;
}

/** 標記 / 取消標記登入者自己的任務；樂觀更新全站共用的「我的標記」查詢 */
export function useTogglePin() {
  const qc = useQueryClient();
  const me = useCurrentUser()?.id ?? 0;
  const key = personalKeys.pins(me);
  return useMutation({
    mutationFn: async ({ taskId, pinned }) => {
      if (pinned) await api.put(`/personal/pins/${taskId}`);
      else await api.delete(`/personal/pins/${taskId}`);
    },
    onMutate: async ({ taskId, pinned }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      if (pinned) {
        const task = findCachedTask(qc, taskId);
        if (task) {
          const t = Date.now();
          const pin = {
            id: -taskId,
            userId: me,
            title: '',
            note: '',
            detail: '',
            status: 'todo',
            dueDate: null,
            isDone: false,
            taskId,
            sortOrder: 0,
            createdAt: t,
            updatedAt: t,
          };
          qc.setQueryData(key, (list) => [
            { pin, task },
            ...(list ?? []).filter((p) => p.task.id !== taskId),
          ]);
        }
      } else {
        qc.setQueryData(key, (list) => list?.filter((p) => p.task.id !== taskId));
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}
