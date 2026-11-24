import { z } from 'zod';
import { timestamps } from './common.ts';
import type { Task } from './tasks.ts';

export const personalItem = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  title: z.string(),
  note: z.string(),
  isDone: z.boolean(),
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
});
export type PersonalCreateInput = z.infer<typeof personalCreateInput>;

/** PATCH 只送改動欄位；sortOrder 由前端以相鄰兩項的中間值計算 */
export const personalUpdateInput = z.object({
  title: z.string().trim().min(1, '請輸入待辦內容').max(500).optional(),
  note: z.string().max(5_000).optional(),
  isDone: z.boolean().optional(),
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
