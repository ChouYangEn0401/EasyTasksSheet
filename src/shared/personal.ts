// 骨架：由 feat/personal 實作。
import { z } from 'zod';
import { timestamps } from './common.ts';

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
