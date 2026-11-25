import { z } from 'zod';
import { dateString, timestamps } from './common.ts';
import { customValues } from './properties.ts';

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export const taskPriority = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPriority>;

export const task = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  title: z.string(),
  description: z.string(),
  statusId: z.number().int(),
  assigneeId: z.number().int().nullable(),
  priority: taskPriority,
  startDate: dateString.nullable(),
  dueDate: dateString.nullable(),
  estimateHours: z.number().nullable(),
  progress: z.number().int().min(0).max(100),
  sortOrder: z.number(),
  custom: customValues,
  createdBy: z.number().int().nullable(),
  updatedBy: z.number().int().nullable(),
  deletedAt: z.number().int().nullable(),
  /**
   * 完成時間（ms）：狀態類別轉為 done 時由後端寫入，改回非 done 時為 null。
   * 選填以相容舊資料與既有測試資料。
   */
  completedAt: z.number().int().nullable().optional(),
  /** 相關任務數（只在 GET /api/tasks 清單與複製回應中提供；不含已刪除的對方任務） */
  relationCount: z.number().int().optional(),
  /** 待辦清單項目數 / 已完成數（後端以單一聚合查詢附加；選填以相容既有資料） */
  checklistTotal: z.number().int().min(0).optional(),
  checklistDone: z.number().int().min(0).optional(),
  ...timestamps,
});
export type Task = z.infer<typeof task>;

/** 建立任務只需 title，其餘由後端給預設值 */
export const taskCreateInput = z.object({
  title: z.string().trim().min(1).max(500),
  projectId: z.number().int().optional(),
  description: z.string().max(20_000).optional(),
  statusId: z.number().int().optional(),
  assigneeId: z.number().int().nullable().optional(),
  priority: taskPriority.optional(),
  startDate: dateString.nullable().optional(),
  dueDate: dateString.nullable().optional(),
  estimateHours: z.number().min(0).nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  sortOrder: z.number().optional(),
  custom: customValues.optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateInput>;

/** PATCH 只送改動的欄位（欄位層級後寫入者勝） */
export const taskUpdateInput = taskCreateInput.partial();
export type TaskUpdateInput = z.infer<typeof taskUpdateInput>;

/** 逗號分隔的 id 清單，例如 `1,3` */
const idList = z
  .string()
  .regex(/^\d+(,\d+)*$/, '格式須為逗號分隔的 id')
  .transform((s) => s.split(',').map(Number));

/** GET /api/tasks 的篩選；多值以逗號分隔，assignee 可含 `none`（未指派） */
export const taskListQuery = z.object({
  project: idList.optional(),
  assignee: z
    .string()
    .regex(/^(\d+|none)(,(\d+|none))*$/, '格式須為逗號分隔的 id 或 none')
    .transform((s) => {
      const parts = s.split(',');
      return { ids: parts.filter((p) => p !== 'none').map(Number), none: parts.includes('none') };
    })
    .optional(),
  status: idList.optional(),
  q: z.string().trim().max(200).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuery>;
