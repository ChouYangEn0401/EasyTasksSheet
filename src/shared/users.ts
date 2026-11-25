import { z } from 'zod';
import { timestamps } from './common.ts';

/** 三層角色：root（超級管理員）> manager（管理者）> user（成員）。docs/permissions.md */
export const USER_ROLES = ['root', 'manager', 'user'] as const;
export const userRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRole>;

/** 角色顯示名稱（全站一致） */
export const ROLE_LABELS: Record<UserRole, string> = {
  root: '超級管理員',
  manager: '管理者',
  user: '成員',
};

/** 階層：數字越大權限越高 */
export const ROLE_RANK: Record<UserRole, number> = { user: 1, manager: 2, root: 3 };

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
