import { useEffect, useRef, useState } from 'react';
import type { PropertyDef } from '../../shared/properties.ts';
import type { Task } from '../../shared/tasks.ts';
import { flashItem } from './motion.ts';
import { onRemoteChange } from './sync.ts';
import { quoteName, toast } from './toast.ts';

/*
 * 他人變更提示（docs/design/realtime-feedback.md §4）：
 * 「改了哪些欄位」由前端比對重抓前後的資料得出；比對不出來時只說「更新了此項目」。
 */

/** Task 欄位 → [抽屜欄位 key, 顯示名稱] */
const TASK_FIELDS: [keyof Task, string, string][] = [
  ['title', 'title', '標題'],
  ['statusId', 'status', '狀態'],
  ['assigneeId', 'assignee', '負責人'],
  ['projectId', 'project', '專案'],
  ['priority', 'priority', '優先度'],
  ['startDate', 'startDate', '開始日'],
  ['dueDate', 'dueDate', '到期日'],
  ['estimateHours', 'estimateHours', '預估工時'],
  ['progress', 'progress', '進度'],
  ['description', 'description', '描述'],
];

export type FieldChange = { key: string; label: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 比對兩版任務，回傳變動的欄位（排序值不算；自訂欄位 key 為 `p<id>`） */
export function diffTaskFields(
  before: Task,
  after: Task,
  properties: Pick<PropertyDef, 'id' | 'name'>[] = [],
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [prop, key, label] of TASK_FIELDS) {
    if (!same(before[prop], after[prop])) out.push({ key, label });
  }
  const names = new Map(properties.map((p) => [String(p.id), p.name]));
  const keys = new Set([...Object.keys(before.custom ?? {}), ...Object.keys(after.custom ?? {})]);
  for (const k of keys) {
    if (same(before.custom?.[k], after.custom?.[k])) continue;
    out.push({ key: `p${k}`, label: names.get(k) ?? '自訂欄位' });
  }
  return out;
}

/** 欄位名最多列 3 個，其餘寫「等 N 項」 */
export function formatFieldList(labels: string[]): string {
  const uniq = [...new Set(labels)];
  if (uniq.length <= 3) return uniq.join('、');
  return `${uniq.slice(0, 3).join('、')} 等 ${uniq.length - 3} 項`;
}

/** 單人寫姓名；多人寫「李大華 等 2 人」 */
export function formatActors(names: string[]): string {
  const uniq = [...new Set(names)];
  if (uniq.length <= 1) return uniq[0] ?? '其他成員';
  return `${uniq[0]} 等 ${uniq.length} 人`;
}

export const NOTICE_MS = 6000;
/** 同一人在此時間內對同一項目的多次變更只提示一次 */
export const MERGE_MS = 10_000;

export type TaskNotice = {
  actorIds: number[];
  fields: FieldChange[];
  /** 比對不出欄位（只說「更新了此項目」） */
  unknown: boolean;
  at: number;
};

export type RemoteTaskState = {
  notice: TaskNotice | null;
  /** 他人刪除了此任務：刪除者 id（null = 未知） */
  deletedBy: number | null | undefined;
  dismiss: () => void;
};

/**
 * TaskDrawer 用：監聽他人對 taskId 的變更。
 * 更新 → 等資料重抓後比對欄位，顯示提示條 6 秒並對變動欄位播更新高亮；
 * 刪除 → deletedBy 設為刪除者，並發 warning toast。
 */
export function useRemoteTaskChanges(
  taskId: number,
  task: Task | undefined,
  options: {
    properties?: Pick<PropertyDef, 'id' | 'name'>[];
    nameOf: (userId: number | null) => string;
  },
): RemoteTaskState {
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const [deletedBy, setDeletedBy] = useState<number | null | undefined>(undefined);
  const pending = useRef<{ actorId: number | null; before: Task } | null>(null);
  const latest = useRef({ task, options });
  useEffect(() => {
    latest.current = { task, options };
  });

  useEffect(
    () =>
      onRemoteChange((c) => {
        if (c.entityType !== 'task' || c.entityId !== taskId) return;
        const { task: cur, options: opts } = latest.current;
        if (c.action === 'delete') {
          setDeletedBy(c.actorId);
          if (cur)
            toast({
              key: `task-deleted:${taskId}`,
              tone: 'warning',
              title: `${opts.nameOf(c.actorId)} 刪除了${quoteName(cur.title)}`,
            });
          return;
        }
        if (c.action === 'update' && cur && !pending.current)
          pending.current = { actorId: c.actorId, before: cur };
      }),
    [taskId],
  );

  // 重抓後的資料到達：比對欄位
  const updatedAt = task?.updatedAt;
  useEffect(() => {
    const p = pending.current;
    if (!p || !task || task.updatedAt === p.before.updatedAt) return;
    pending.current = null;
    const fields = diffTaskFields(p.before, task, latest.current.options.properties);
    for (const f of fields) flashItem(`taskfield:${taskId}:${f.key}`);
    const now = Date.now();
    setNotice((prev) => {
      const actorIds = p.actorId != null ? [p.actorId] : [];
      if (prev && now - prev.at < MERGE_MS) {
        const mergedFields = [...prev.fields];
        for (const f of fields) if (!mergedFields.some((x) => x.key === f.key)) mergedFields.push(f);
        return {
          actorIds: [...new Set([...prev.actorIds, ...actorIds])],
          fields: mergedFields,
          unknown: prev.unknown && fields.length === 0,
          at: prev.at,
        };
      }
      return { actorIds, fields, unknown: fields.length === 0, at: now };
    });
  }, [task, updatedAt, taskId]);

  // 6 秒後收起
  const noticeAt = notice?.at;
  useEffect(() => {
    if (noticeAt == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS - (Date.now() - noticeAt));
    return () => window.clearTimeout(t);
  }, [noticeAt]);

  return { notice, deletedBy, dismiss: () => setNotice(null) };
}

/** 提示條文字：「李大華 剛更新了此任務 · 狀態、到期日」 */
export function noticeText(n: TaskNotice, nameOf: (id: number | null) => string, noun = '此任務'): string {
  const who = formatActors(n.actorIds.length ? n.actorIds.map((id) => nameOf(id)) : [nameOf(null)]);
  if (n.unknown || !n.fields.length) return `${who} 剛更新了此項目`;
  return `${who} 剛更新了${noun} · ${formatFieldList(n.fields.map((f) => f.label))}`;
}
