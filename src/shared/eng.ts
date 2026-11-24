// 骨架：由 feat/eng-tracking 實作。
import { z } from 'zod';
import { timestamps } from './common.ts';

export const repo = z.object({
  id: z.number().int(),
  name: z.string(),
  localPath: z.string().nullable(),
  remoteSlug: z.string().nullable(),
  ...timestamps,
});
export type Repo = z.infer<typeof repo>;

export const WORKTREE_STATES = [
  'ok',
  'missing',
  'unregistered',
  'merged_not_cleaned',
  'dirty',
  'stale',
] as const;
export const worktreeState = z.enum(WORKTREE_STATES);
export type WorktreeState = z.infer<typeof worktreeState>;
