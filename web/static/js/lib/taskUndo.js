import { useSyncExternalStore } from 'preact/compat';

import { TASK_PRIORITY_LABELS } from '../shared/tasks.js';

import { ApiError, api } from './api.js';
import { truncate } from './format.js';
import { enterItem, taskFxKey } from './motion.js';
import { queryKeys } from './queryClient.js';
import {
  applyTaskPatch,
  describeTaskUpdate,
  fieldKeysOf,
  fieldLabel,
  findConflicts,
  isNoop,
  mergeChanges,
  pickFields,
  quote,
  toTaskPatch,
} from './taskUndoModel.js';
import { toast } from './toast.js';
import { registerUndoable } from './undo.js';

/*
 * 任務核心操作的復原（docs/design/undo.md）：由 lib/hooks.ts 與 features/tasks/data.ts 的任務 mutation
 * 成功後自動登記；復原 / 重做本身也走 mutation（樂觀更新、失敗回復；sync.ts 的延後重抓規則照常生效），
 * 並以 errorToast: false 避免重複的失敗提示（失敗由 UndoManager 統一顯示）。
 */

/** 任務 mutation 的復原選項；false = 不入堆疊（例如復原自己觸發的寫入、拖曳過程的暫存） */

/** 登記結果的回填物件（id = null 代表未入堆疊） */

let groupSeq = 0;

/** 產生新的群組鍵（同一次拖曳放下的多筆寫入帶相同的 undo.group） */
export function newUndoGroup(prefix = 'group') {
  groupSeq += 1;
  return `${prefix}:${groupSeq}`;
}

// ── 快取工具 ─────────────────────────────────────────

const listEntries = (qc) => qc.getQueriesData({ queryKey: queryKeys.tasks.lists() });

/**
 * 從快取找任務：詳情與各清單中取 updatedAt 最新的一份
 * （沒有在看的詳情快取不會隨 SSE 重抓，可能比清單舊）
 */
export function findCachedTask(qc, id) {
  let best = qc.getQueryData(queryKeys.tasks.detail(id));
  for (const [, list] of listEntries(qc)) {
    const t = list?.find((x) => x.id === id);
    if (t && (!best || t.updatedAt > best.updatedAt)) best = t;
  }
  return best;
}

function lookups(qc) {
  const statuses = qc.getQueryData(queryKeys.statuses) ?? [];
  const props = qc.getQueryData(queryKeys.properties) ?? [];
  const users = qc.getQueryData(queryKeys.users) ?? [];
  const projects = qc.getQueryData(queryKeys.projects) ?? [];
  return {
    statusName: (id) => statuses.find((s) => s.id === id)?.name,
    propertyName: (key) => props.find((p) => String(p.id) === key)?.name,
    propertyType: (key) => props.find((p) => String(p.id) === key)?.type,
    userName: (id) => users.find((u) => u.id === id)?.displayName,
    projectName: (id) => projects.find((p) => p.id === id)?.name,
  };
}

/** 衝突對話框用：把欄位值轉成可讀文字 */
export function formatFieldValue(qc, field, value) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return '空白';
  const l = lookups(qc);
  if (field === 'statusId') return l.statusName(Number(value)) ?? String(value);
  if (field === 'assigneeId') return l.userName(Number(value)) ?? String(value);
  if (field === 'projectId') return l.projectName(Number(value)) ?? String(value);
  if (field === 'priority') return TASK_PRIORITY_LABELS[String(value)] ?? String(value);
  if (field === 'progress') return `${String(value)}%`;
  if (field.startsWith('custom.') && l.propertyType(field.slice(7)) === 'person')
    return l.userName(Number(value)) ?? String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.join('、');
  return truncate(String(value).replace(/\s+/g, ' '), 30);
}

// ── 以 mutation 執行（復原 / 重做本身） ─────────────────

function runMutation(
  qc,
  options,

  vars,
) {
  return qc
    .getMutationCache()
    .build(qc, { ...options, meta: { errorToast: false } })
    .execute(vars);
}

function snapshot(qc, id) {
  return { lists: listEntries(qc), detail: qc.getQueryData(queryKeys.tasks.detail(id)) };
}

function restoreSnapshot(qc, id, ctx) {
  if (!ctx) return;
  for (const [key, list] of ctx.lists) qc.setQueryData(key, list);
  if (ctx.detail) qc.setQueryData(queryKeys.tasks.detail(id), ctx.detail);
}

function replaceInLists(qc, fn) {
  for (const [key, list] of listEntries(qc)) if (list) qc.setQueryData(key, fn(list));
}

/** PATCH（樂觀套用、失敗回復） */
export function patchTask(qc, id, patch) {
  return runMutation(
    qc,
    {
      mutationFn: (p) => api.patch(`/tasks/${id}`, p),
      onMutate: async (p) => {
        await qc.cancelQueries({ queryKey: queryKeys.tasks.all });
        const ctx = snapshot(qc, id);
        replaceInLists(qc, (list) => list.map((t) => (t.id === id ? applyTaskPatch(t, p) : t)));
        if (ctx.detail) qc.setQueryData(queryKeys.tasks.detail(id), applyTaskPatch(ctx.detail, p));
        return ctx;
      },
      onError: (_e, _p, ctx) => restoreSnapshot(qc, id, ctx),
      onSuccess: (task) => {
        qc.setQueryData(queryKeys.tasks.detail(task.id), task);
        replaceInLists(qc, (list) => list.map((t) => (t.id === task.id ? task : t)));
        // 不等重抓：復原很快結束（lib/undo.ts）
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
      },
    },
    patch,
  );
}

/** 軟刪除（樂觀自清單移除、失敗回復） */
export function softDeleteTask(qc, id) {
  return runMutation(
    qc,
    {
      mutationFn: (tid) => api.delete(`/tasks/${tid}`),
      onMutate: async () => {
        await qc.cancelQueries({ queryKey: queryKeys.tasks.all });
        const ctx = snapshot(qc, id);
        replaceInLists(qc, (list) => list.filter((t) => t.id !== id));
        return ctx;
      },
      onError: (_e, _v, ctx) => restoreSnapshot(qc, id, ctx),
      onSuccess: () => {
        // 開著的抽屜不移除詳情（否則會立即重抓而得到 404）
        const detail = qc.getQueryCache().find({ queryKey: queryKeys.tasks.detail(id) });
        if (!detail?.getObserversCount()) qc.removeQueries({ queryKey: queryKeys.tasks.detail(id) });
        // 不等重抓：復原很快結束（lib/undo.ts）
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
      },
    },
    id,
  );
}

/** 還原軟刪除（POST /api/tasks/:id/restore） */
export function restoreTask(qc, id) {
  return runMutation(
    qc,
    {
      mutationFn: (tid) => api.post(`/tasks/${tid}/restore`, {}),
      onSuccess: (task) => {
        qc.setQueryData(queryKeys.tasks.detail(task.id), task);
        enterItem(taskFxKey(task.id));
        // 不等重抓：復原很快結束（lib/undo.ts）
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
      },
    },
    id,
  );
}

const isNotFound = (err) => err instanceof ApiError && err.status === 404;

function notifyGone(label) {
  toast({ tone: 'warning', title: '此任務已不存在', description: `已從復原紀錄移除：${label}` });
}

// ── 衝突對話框（promise 化；由 features/undo/UndoConflictDialog 呈現） ──

let conflictState = null;
let conflictHostCount = 0;
const conflictListeners = new Set();
const emitConflict = () => conflictListeners.forEach((fn) => fn());

/** 詢問使用者；沒有掛載對話框時視為「略過這項」（不覆蓋別人的修改） */
export function askConflict(prompt) {
  if (conflictHostCount === 0) return Promise.resolve('skip');
  conflictState?.resolve('skip');
  return new Promise((resolve) => {
    conflictState = {
      ...prompt,
      resolve: (c) => {
        conflictState = null;
        emitConflict();
        resolve(c);
      },
    };
    emitConflict();
  });
}

export function useConflictPrompt() {
  return useSyncExternalStore(
    (fn) => {
      conflictListeners.add(fn);
      conflictHostCount += 1;
      return () => {
        conflictListeners.delete(fn);
        conflictHostCount -= 1;
      };
    },
    () => conflictState,
    () => conflictState,
  );
}

// ── 登記：更新 ───────────────────────────────────────

/**
 * 套用一組欄位變更的反向（undo）或正向（redo）：
 * 先取最新資料比對「這次會動到的欄位」；被別人改過 → 詢問；任務已不存在 → 'drop'。
 */
async function applyChanges(qc, changes, kind, label) {
  const live = [];
  const conflicts = [];
  for (const change of changes) {
    let current;
    try {
      current = await api.get(`/tasks/${change.id}`);
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
    const expected = kind === 'undo' ? change.after : change.before;
    conflicts.push(...findConflicts(pickFields(current, Object.keys(expected)), expected));
    live.push({ change, current });
  }
  if (live.length === 0) {
    notifyGone(label);
    return 'drop';
  }
  if (conflicts.length) {
    const first = conflicts[0];
    const choice = await askConflict({
      kind,
      label,
      fieldLabel: fieldLabel(first.field, lookups(qc).propertyName),
      currentText: formatFieldValue(qc, first.field, first.current),
      more: conflicts.length - 1,
    });
    if (choice === 'skip') {
      toast({ tone: 'info', title: `已略過：${label}` });
      return 'drop';
    }
  }
  for (const { change } of live) {
    const target = kind === 'undo' ? change.before : change.after;
    try {
      await patchTask(qc, change.id, toTaskPatch(target));
    } catch (err) {
      if (isNotFound(err) && live.length === 1) {
        notifyGone(label);
        return 'drop';
      }
      throw err;
    }
  }
}

function taskUpdateUndo(qc, changes, opts) {
  const label = opts.label ?? describeTaskUpdate(changes, lookups(qc));
  const sorted = changes.length === 1 ? Object.keys(changes[0].after).sort().join(',') : '';
  return {
    label,
    mergeKey: opts.group ? `group:${opts.group}` : `task:${changes[0]?.id}:${sorted}`,
    mergeWindowMs: opts.group ? Infinity : undefined,
    meta: { changes },
    undo: () => applyChanges(qc, changes, 'undo', label),
    redo: () => applyChanges(qc, changes, 'redo', label),
    merge: (older) => {
      const merged = mergeChanges(older.meta?.changes ?? [], changes);
      // 群組以第一筆指定的文案為準（例如拖曳時主卡片的「把『X』移到…」）
      const next = taskUpdateUndo(qc, merged, {
        label: opts.group ? (opts.label ?? older.label) : opts.label,
        group: opts.group,
      });
      // 改過去又改回來（A→B→A）：沒有實際變更，移出堆疊
      return { ...next, noop: merged.every(isNoop) };
    },
  };
}

/**
 * 任務 PATCH 成功後登記（hooks.ts / data.ts 呼叫）。
 * before：動作前的任務（快取讀出或呼叫端提供）；result：伺服器回傳的新任務。
 */
export function recordTaskUpdate(qc, { id, patch, before, result, option }) {
  if (option === false || !before) return;
  const keys = fieldKeysOf(patch);
  if (!keys.length) return;
  const change = {
    id,
    title: result.title,
    // before 只帶部分欄位時（例如看板只帶 statusId / sortOrder），其餘以伺服器結果補（視為未變更）
    before: pickFields({ ...result, ...before }, keys),
    after: pickFields(result, keys),
  };
  if (isNoop(change)) return;
  const entryId = registerUndoable(
    taskUpdateUndo(qc, [change], { label: option?.label, group: option?.group }),
  );
  if (option?.handle) option.handle.id = entryId;
}

// ── 登記：新增 / 刪除 ─────────────────────────────────

async function deleteOrDrop(qc, id, label) {
  try {
    await softDeleteTask(qc, id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    notifyGone(label);
    return 'drop';
  }
}

async function restoreOrDrop(qc, id, label) {
  try {
    await restoreTask(qc, id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    notifyGone(label);
    return 'drop';
  }
}

/** 建立任務成功後登記：復原 = 軟刪除；重做 = 還原（內容原封不動） */
export function recordTaskCreate(qc, task, option) {
  if (option === false) return;
  const label = option?.label ?? `建立任務${quote(task.title)}`;
  registerUndoable({
    label,
    undo: () => deleteOrDrop(qc, task.id, label),
    redo: () => restoreOrDrop(qc, task.id, label),
  });
}

/** 刪除任務成功後登記：復原 = 還原；重做 = 再次軟刪除 */
export function recordTaskDelete(qc, task, option) {
  if (option === false) return;
  const label = option?.label ?? `刪除任務${quote(task.title)}`;
  registerUndoable({
    label,
    undo: () => restoreOrDrop(qc, task.id, label),
    redo: () => deleteOrDrop(qc, task.id, label),
  });
}
