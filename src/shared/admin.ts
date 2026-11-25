// 成員管理（feat/admin-users）：/api/admin/users 的輸入與回應格式
import { z } from 'zod';
import { publicUser, userRole } from './users.ts';

/** 帳號格式：3–32 個小寫英文字母、數字或 . _ -，須以字母或數字開頭（輸入會先轉小寫） */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const USERNAME_FORMAT_MESSAGE = '帳號須為 3–32 個英文字母、數字或 . _ -，且以字母或數字開頭';
export const USERNAME_REQUIRED_MESSAGE = '請輸入帳號';
export const DISPLAY_NAME_REQUIRED_MESSAGE = '請輸入顯示名稱';
export const USERNAME_TAKEN_MESSAGE = '此帳號已被使用';
export const LAST_ROOT_MESSAGE = '至少需保留一位超級管理員';
/** 「列入總覽統計」開關的說明（成員管理頁 Tooltip / 欄位說明） */
export const IN_OVERVIEW_HINT =
  '關閉後，這個帳號不會出現在總覽的成員卡片與統計，適合只負責管理的帳號。任務仍可指派給他。';
/** manager 無法操作 root 帳號（後端 403，前端預先停用並說明） */
export const ROOT_ONLY_MESSAGE = '只有超級管理員可以管理此帳號';

export const adminUsername = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, USERNAME_REQUIRED_MESSAGE)
  .regex(USERNAME_PATTERN, USERNAME_FORMAT_MESSAGE);

const displayName = z.string().trim().min(1, DISPLAY_NAME_REQUIRED_MESSAGE).max(100, '顯示名稱最多 100 字');

/** POST /api/admin/users：臨時密碼由後端產生，回應中只回傳一次 */
export const adminUserCreateInput = z.object({
  username: adminUsername,
  displayName,
  role: userRole.default('user'),
  /** 省略時：root 不列入、其餘列入 */
  inOverview: z.boolean().optional(),
});
export type AdminUserCreateInput = z.input<typeof adminUserCreateInput>;

/** PATCH /api/admin/users/:id：只送改動欄位（帳號建立後不可修改） */
export const adminUserUpdateInput = z
  .object({
    displayName: displayName.optional(),
    role: userRole.optional(),
    isActive: z.boolean().optional(),
    inOverview: z.boolean().optional(),
  })
  .strict();
export type AdminUserUpdateInput = z.infer<typeof adminUserUpdateInput>;

/** 管理頁的成員資料：公開資料 + 登入鎖定到期時間（未鎖定為 null） */
export const adminUser = publicUser.extend({
  lockedUntil: z.number().int().nullable(),
});
export type AdminUser = z.infer<typeof adminUser>;

/** 新增成員、重設密碼的回應：tempPassword 只在此回傳一次 */
export const adminTempPasswordResponse = z.object({
  user: adminUser,
  tempPassword: z.string(),
});
export type AdminTempPasswordResponse = z.infer<typeof adminTempPasswordResponse>;

type RoleLike = { id: number; role: string; isActive: boolean };

/**
 * 是否為「唯一啟用中的 root」（停用或降級會使系統沒有超級管理員）。
 * 與後端 is_last_active_root 同規則：前端據此預先停用選項，後端據此拒絕請求。
 */
export function isLastActiveRoot(target: RoleLike, all: readonly RoleLike[]): boolean {
  if (target.role !== 'root' || !target.isActive) return false;
  return !all.some((u) => u.id !== target.id && u.role === 'root' && u.isActive);
}
