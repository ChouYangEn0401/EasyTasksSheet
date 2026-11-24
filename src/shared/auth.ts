import { z } from 'zod';
import { publicUser } from './users.ts';

export const loginInput = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginInput>;

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

export const meResponse = z.object({
  user: publicUser,
  session: z.object({ expiresAt: z.number(), idleTimeoutMs: z.number() }),
});
export type MeResponse = z.infer<typeof meResponse>;
