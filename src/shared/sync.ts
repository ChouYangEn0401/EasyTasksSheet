import { z } from 'zod';

/** changes 表的 entity_type；所有寫入 API 透過 recordChange() 記錄 */
export const ENTITY_TYPES = [
  'user',
  'project',
  'status',
  'task',
  'property',
  'feedback',
  'personal',
  'repo',
  'worktree_plan',
] as const;
export const entityType = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityType>;

export const CHANGE_ACTIONS = ['create', 'update', 'delete'] as const;
export const changeAction = z.enum(CHANGE_ACTIONS);
export type ChangeAction = z.infer<typeof changeAction>;

export const change = z.object({
  id: z.number().int(),
  entityType,
  entityId: z.number().int(),
  action: changeAction,
  actorId: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Change = z.infer<typeof change>;
