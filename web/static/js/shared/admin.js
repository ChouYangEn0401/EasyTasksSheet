// 成員管理（feat/admin-users）：/api/admin/users 的輸入與回應格式

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

/**
 * 帳號驗證（以前是 zod schema；介面維持 safeParse 的形狀）：trim、轉小寫，空白或格式不符回錯誤訊息。
 * 與後端規則一致。
 */
export const adminUsername = {
  safeParse(value) {
    const data = String(value ?? '')
      .trim()
      .toLowerCase();
    const message =
      data === '' ? USERNAME_REQUIRED_MESSAGE : USERNAME_PATTERN.test(data) ? null : USERNAME_FORMAT_MESSAGE;
    return message ? { success: false, error: { issues: [{ message }] } } : { success: true, data };
  },
};

/**
 * 是否為「唯一啟用中的 root」（停用或降級會使系統沒有超級管理員）。
 * 與後端 is_last_active_root 同規則：前端據此預先停用選項，後端據此拒絕請求。
 */
export function isLastActiveRoot(target, all) {
  if (target.role !== 'root' || !target.isActive) return false;
  return !all.some((u) => u.id !== target.id && u.role === 'root' && u.isActive);
}
