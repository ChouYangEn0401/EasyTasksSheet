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

/** session 資訊：expiresAt 為 9 小時絕對期限；閒置截止 = lastActiveAt + idleTimeoutMs */
export const sessionInfo = z.object({
  expiresAt: z.number(),
  lastActiveAt: z.number(),
  idleTimeoutMs: z.number(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;

/** GET /api/auth/me、POST /api/auth/login 的回應 */
export const meResponse = z.object({ user: publicUser, session: sessionInfo });
export type MeResponse = z.infer<typeof meResponse>;
