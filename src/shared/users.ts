import { z } from 'zod';
import { timestamps } from './common.ts';

export const USER_ROLES = ['admin', 'member'] as const;
export const userRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRole>;

/** 對外公開的使用者資料（不含 password_hash） */
export const publicUser = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: userRole,
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  ...timestamps,
});
export type PublicUser = z.infer<typeof publicUser>;
