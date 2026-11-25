import { z } from 'zod';
import { publicUser } from './users.ts';

export const loginInput = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginInput>;

/** 預設管理員的初始密碼；改密碼時不可再使用 */
export const DEFAULT_ADMIN_PASSWORD = 'password';

/**
 * POST /api/auth/password。username 只在預設管理員首次重設（me.mustChangeUsername）時送出，
 * 其他情況送出會被拒絕。
 */
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
  username: z.string().max(64).optional(),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/** session 資訊：expiresAt 為 9 小時絕對期限；閒置截止 = lastActiveAt + idleTimeoutMs */
export const sessionInfo = z.object({
  expiresAt: z.number(),
  lastActiveAt: z.number(),
  idleTimeoutMs: z.number(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;

/**
 * GET /api/auth/me、POST /api/auth/login 的回應。
 * mustChangeUsername：預設管理員首次登入，須同時設定新帳號與新密碼。
 * capabilities：登入者具備的權限（src/shared/permissions.ts），前端據此顯示 / 隱藏功能。
 */
export const meResponse = z.object({
  user: publicUser,
  capabilities: z.array(z.string()),
  session: sessionInfo,
  mustChangeUsername: z.boolean(),
});
export type MeResponse = z.infer<typeof meResponse>;
