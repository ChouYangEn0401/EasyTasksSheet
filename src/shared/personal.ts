import { z } from 'zod';
import { dateString, timestamps } from './common.ts';
import type { Task } from './tasks.ts';

/** 自由待辦的小狀態：待處理 / 進行中 / 延後 / 取消 / 完成（done 與 isDone 一致，由後端維護） */
export const personalStatus = z.enum(['todo', 'doing', 'deferred', 'cancelled', 'done']);
export type PersonalStatus = z.infer<typeof personalStatus>;

export const PERSONAL_STATUS_LABEL: Record<PersonalStatus, string> = {
  todo: '待處理',
  doing: '進行中',
  deferred: '延後',
  cancelled: '取消',
  done: '完成',
};
export const PERSONAL_STATUSES = Object.keys(PERSONAL_STATUS_LABEL) as PersonalStatus[];

export const personalItem = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  title: z.string(),
  /** 備註：列上常駐顯示的短說明 */
  note: z.string(),
  /** 細節：inspector 裡的長文 */
  detail: z.string(),
  status: personalStatus,
  dueDate: dateString.nullable(),
  isDone: z.boolean(),
  /** 完成時間（ms）：狀態變為 done 時寫入，改回其他狀態時清空；舊資料缺漏時視為 updatedAt */
  doneAt: z.number().int().nullable().optional(),
  /** 有值 = 標記的任務；null = 自由待辦 */
  taskId: z.number().int().nullable(),
  sortOrder: z.number(),
  ...timestamps,
});
export type PersonalItem = z.infer<typeof personalItem>;

/** 標記的任務：標記本身 + 任務（已軟刪除的任務不回傳） */
export type PinnedTask = { pin: PersonalItem; task: Task };

/**
 * 查詢 / 寫入的目標成員（?user=<id>）；省略即登入者本人。
 * 讀取可指定任何成員（唯讀檢視）；寫入若指定他人一律 403。
 */
export const personalUserQuery = z.object({
  user: z.coerce.number().int().positive().optional(),
});

/** 建立自由待辦：只需 title；新項目排在清單最上方 */
export const personalCreateInput = z.object({
  title: z.string().trim().min(1, '請輸入待辦內容').max(500),
  note: z.string().max(5_000).optional(),
  detail: z.string().max(50_000).optional(),
  status: personalStatus.optional(),
  dueDate: dateString.nullable().optional(),
});
export type PersonalCreateInput = z.infer<typeof personalCreateInput>;

/** PATCH 只送改動欄位；sortOrder 由前端以相鄰兩項的中間值計算 */
export const personalUpdateInput = z.object({
  title: z.string().trim().min(1, '請輸入待辦內容').max(500).optional(),
  note: z.string().max(5_000).optional(),
  detail: z.string().max(50_000).optional(),
  isDone: z.boolean().optional(),
  /** 設為 done 時 isDone 同步為 true；從 done 改回其他狀態則為 false */
  status: personalStatus.optional(),
  /** null = 清除到期日 */
  dueDate: dateString.nullable().optional(),
  sortOrder: z.number().finite().optional(),
});
export type PersonalUpdateInput = z.infer<typeof personalUpdateInput>;

/**
 * 把 list[from] 移到索引 to 時的新 sortOrder：取新鄰居的中間值（sort_order 為 REAL，不必重編號）。
 * list 為移動前的清單（已依 sortOrder 遞增排序）。
 */
export function sortOrderForMove(list: readonly { sortOrder: number }[], from: number, to: number): number {
  const rest = list.filter((_, i) => i !== from);
  const prev = rest[to - 1];
  const next = rest[to];
  if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
  if (prev) return prev.sortOrder + 1;
  if (next) return next.sortOrder - 1;
  return list[from]?.sortOrder ?? 0;
}

/* ── 匯報報告（GET /api/personal/report，docs/design/personal.md「匯報報告」） ── */

/** include 查詢參數可用的項目（預設只回完成事項） */
export const REPORT_INCLUDE_KEYS = ['doing', 'deferred', 'cancelled', 'created'] as const;
export type ReportIncludeKey = (typeof REPORT_INCLUDE_KEYS)[number];
/** 區間最長天數（含頭尾日），超過回 400 */
export const REPORT_MAX_DAYS = 366;

export type ReportTask = {
  id: number;
  title: string;
  projectId: number;
  projectName: string;
  projectColor: string;
  statusName: string;
  /** 完成日（台北時區 YYYY-MM-DD）；非完成任務為 null */
  completedDate: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  priority: string;
  /** 只有 createdTasks 會有：建立日 */
  createdDate?: string;
};

export type ReportTodo = {
  id: number;
  title: string;
  note: string;
  /** 細節前 200 字 */
  detail: string;
  status: PersonalStatus;
  doneDate: string | null;
  dueDate: string | null;
};

export type PersonalReport = {
  from: string;
  to: string;
  timeZone: string;
  user: { id: number; displayName: string } | null;
  summary: {
    completedTaskCount: number;
    completedTodoCount: number;
    byProject: { projectId: number; projectName: string; projectColor: string; count: number }[];
    /** 有填估時才會出現 */
    estimatedHours?: number;
    hoursKnown?: number;
  };
  completedTasks: ReportTask[];
  completedTodos: ReportTodo[];
  inProgress?: ReportTask[];
  deferredTodos?: ReportTodo[];
  createdTasks?: ReportTask[];
};
