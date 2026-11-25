import { adminUsername } from '../../../shared/admin.ts';
import { DEFAULT_ADMIN_PASSWORD } from '../../../shared/auth.ts';

/** 個人設定頁的純函式（表單驗證、變更內容、密碼強度）。與後端規則一致。 */

export const MIN_PASSWORD = 8;
export const DISPLAY_NAME_MAX = 100;

export type Profile = {
  id: number;
  username: string;
  displayName: string;
  role: string;
  createdAt: number;
  lastLoginAt: number | null;
};

export type ProfilePatch = { displayName?: string; username?: string; currentPassword?: string };

const ROLE_LABELS: Record<string, string> = {
  admin: '管理員',
  member: '成員',
  root: '最高管理者',
  manager: '管理者',
  user: '成員',
};

/** 角色顯示名稱（未知角色顯示原值） */
export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export function validateDisplayName(value: string): string | undefined {
  const v = value.trim();
  if (!v) return '請輸入顯示名稱';
  if (v.length > DISPLAY_NAME_MAX) return `顯示名稱最多 ${DISPLAY_NAME_MAX} 字`;
  return undefined;
}

/** 帳號格式（trim、轉小寫後檢查），規則同成員管理 */
export function validateUsername(value: string): string | undefined {
  const r = adminUsername.safeParse(value);
  return r.success ? undefined : r.error.issues[0]?.message;
}

export const normalizeUsername = (value: string) => value.trim().toLowerCase();

export type ProfileDraft = { displayName: string; username: string; currentPassword: string };

export type ProfileErrors = { displayName?: string; username?: string };

/** 草稿相對於目前資料的變更：未變更的欄位不送出 */
export function profileChanges(draft: ProfileDraft, profile: Profile) {
  return {
    displayName: draft.displayName.trim() !== profile.displayName,
    username: normalizeUsername(draft.username) !== profile.username,
  };
}

export function validateProfile(draft: ProfileDraft, profile: Profile): ProfileErrors {
  const changed = profileChanges(draft, profile);
  const errors: ProfileErrors = {};
  const nameErr = validateDisplayName(draft.displayName);
  if (nameErr) errors.displayName = nameErr;
  if (changed.username) {
    const userErr = validateUsername(draft.username);
    if (userErr) errors.username = userErr;
  }
  return errors;
}

/** 可送出：有變更、無格式錯誤、改帳號時已填目前密碼 */
export function canSubmitProfile(draft: ProfileDraft, profile: Profile): boolean {
  const changed = profileChanges(draft, profile);
  if (!changed.displayName && !changed.username) return false;
  if (Object.keys(validateProfile(draft, profile)).length > 0) return false;
  if (changed.username && !draft.currentPassword) return false;
  return true;
}

/** 組成 PATCH /api/profile 的 body（只含有變更的欄位；改帳號才帶目前密碼） */
export function buildProfilePatch(draft: ProfileDraft, profile: Profile): ProfilePatch {
  const changed = profileChanges(draft, profile);
  const patch: ProfilePatch = {};
  if (changed.displayName) patch.displayName = draft.displayName.trim();
  if (changed.username) {
    patch.username = normalizeUsername(draft.username);
    patch.currentPassword = draft.currentPassword;
  }
  return patch;
}

export type PasswordDraft = { current: string; next: string; confirm: string };
export type PasswordErrors = { next?: string; confirm?: string };

export function validatePasswordForm(d: PasswordDraft): PasswordErrors {
  const errors: PasswordErrors = {};
  if (d.next.length > 0 && d.next.length < MIN_PASSWORD) errors.next = `至少需要 ${MIN_PASSWORD} 個字元`;
  else if (d.next === DEFAULT_ADMIN_PASSWORD) errors.next = '不可使用預設密碼';
  else if (d.next.length > 0 && d.current && d.next === d.current) errors.next = '新密碼不可與目前密碼相同';
  if (d.confirm.length > 0 && d.confirm !== d.next) errors.confirm = '兩次輸入的新密碼不一致';
  return errors;
}

export function canSubmitPassword(d: PasswordDraft): boolean {
  return (
    !!d.current &&
    d.next.length >= MIN_PASSWORD &&
    d.confirm === d.next &&
    Object.keys(validatePasswordForm(d)).length === 0
  );
}

export type Strength = { level: 0 | 1 | 2 | 3; label: string };

/** 簡易強度提示（僅供參考，不影響可否送出）：長度與字元種類 */
export function passwordStrength(pw: string): Strength {
  if (!pw) return { level: 0, label: '' };
  if (pw.length < MIN_PASSWORD || pw === DEFAULT_ADMIN_PASSWORD) return { level: 1, label: '太短或太常見' };
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 12 && kinds >= 3) return { level: 3, label: '強' };
  if (pw.length >= 10 || kinds >= 3) return { level: 2, label: '中等' };
  return { level: 1, label: '偏弱，建議加長或混用字元' };
}
