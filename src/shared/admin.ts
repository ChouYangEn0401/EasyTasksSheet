// 骨架：由 feat/admin-users 實作。
import { z } from 'zod';
import { userRole } from './users.ts';

export const adminUserCreateInput = z.object({
  username: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(100),
  role: userRole.default('member'),
});
export type AdminUserCreateInput = z.infer<typeof adminUserCreateInput>;
