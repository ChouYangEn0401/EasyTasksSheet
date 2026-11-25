import { z } from 'zod';
import { timestamps } from './common.ts';

export const STATUS_CATEGORIES = ['todo', 'doing', 'done'] as const;
export const statusCategory = z.enum(STATUS_CATEGORIES);
export type StatusCategory = z.infer<typeof statusCategory>;

/** 標籤 / 專案 / 狀態 / select 選項共用調色盤鍵名（DB 存鍵名，不存色碼；色值見 docs/design/core-shell.md） */
export const TAG_COLORS = ['gray', 'blue', 'purple', 'green', 'yellow', 'orange', 'red', 'teal'] as const;
export const tagColor = z.enum(TAG_COLORS);
export type TagColor = z.infer<typeof tagColor>;

const color = tagColor;

export const project = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  isArchived: z.boolean(),
  sortOrder: z.number(),
  ...timestamps,
});
export type Project = z.infer<typeof project>;

export const projectCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: color.optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;

export const projectUpdateInput = projectCreateInput.partial().extend({
  isArchived: z.boolean().optional(),
  sortOrder: z.number().optional(),
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>;

export const status = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  category: statusCategory,
  sortOrder: z.number(),
  ...timestamps,
});
export type Status = z.infer<typeof status>;

/** POST /api/statuses（statuses.manage，manager 以上）；color 預設 gray、category 預設 todo、排在最後 */
export const statusCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: color.optional(),
  category: statusCategory.optional(),
  sortOrder: z.number().optional(),
});
export type StatusCreateInput = z.infer<typeof statusCreateInput>;

/** PATCH /api/statuses/:id；DELETE 時仍有任務（含已刪除任務）使用則 409 */
export const statusUpdateInput = statusCreateInput.partial();
export type StatusUpdateInput = z.infer<typeof statusUpdateInput>;

/** POST /api/statuses/:id/migrate-and-delete（statuses.manage）：把使用此狀態的任務改移到目標狀態後刪除 */
export const statusMigrateInput = z.object({ targetStatusId: z.number().int() });
export type StatusMigrateInput = z.infer<typeof statusMigrateInput>;
