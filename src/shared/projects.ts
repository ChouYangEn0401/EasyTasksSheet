import { z } from 'zod';
import { timestamps } from './common.ts';

export const STATUS_CATEGORIES = ['todo', 'doing', 'done'] as const;
export const statusCategory = z.enum(STATUS_CATEGORIES);
export type StatusCategory = z.infer<typeof statusCategory>;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, '顏色格式須為 #RRGGBB');

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
