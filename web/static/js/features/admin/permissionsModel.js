import { CONFIGURABLE_ROLES } from '../../shared/permissions.js';

/** 權限設定頁的純邏輯（docs/design/permissions-config.md） */

/** 尚未儲存的勾選：key = `${role}:${capability}` */

export const cellKey = (role, capability) => `${role}:${capability}`;

/** 某格目前顯示的值（有未儲存變更時用變更值） */
export function cellValue(draft, cap, role) {
  return draft[cellKey(role, cap.key)] ?? cap.effective[role];
}

/** 切換一格；切回伺服器目前的值時移除該筆變更 */
export function toggleCell(draft, cap, role, allowed) {
  const key = cellKey(role, cap.key);
  const next = { ...draft };
  if (allowed === cap.effective[role]) delete next[key];
  else next[key] = allowed;
  return next;
}

/** 與伺服器目前值不同的變更（依角色、再依 capability 順序；受保護項目一律排除） */
export function pendingChanges(matrix, draft) {
  const out = [];
  for (const role of CONFIGURABLE_ROLES)
    for (const cap of matrix.capabilities) {
      if (cap.protected) continue;
      const v = draft[cellKey(role, cap.key)];
      if (v !== undefined && v !== cap.effective[role]) out.push({ role, capability: cap.key, allowed: v });
    }
  return out;
}

/** 變更摘要，例如「成員：＋管理狀態、－編輯任務；管理者：－管理成員」 */
export function changeSummary(matrix, changes) {
  const label = (key) => matrix.capabilities.find((c) => c.key === key)?.label ?? key;
  const roleLabel = (role) => matrix.roles.find((r) => r.role === role)?.label ?? role;
  const parts = [];
  for (const role of [...CONFIGURABLE_ROLES].reverse()) {
    const items = changes
      .filter((c) => c.role === role)
      .map((c) => `${c.allowed ? '＋' : '－'}${label(c.capability)}`);
    if (items.length) parts.push(`${roleLabel(role)}：${items.join('、')}`);
  }
  return parts.join('；');
}

/** 是否與預設不同（顯示「已自訂」） */
export function isCustomized(draft, cap) {
  return CONFIGURABLE_ROLES.some((r) => cellValue(draft, cap, r) !== cap.defaults[r]);
}

/** 伺服器上是否有任何覆寫（決定「還原為預設」是否可按） */
export function hasOverrides(matrix) {
  return matrix.capabilities.some((c) => CONFIGURABLE_ROLES.some((r) => c.overridden[r]));
}

/** 依分組排列（分組順序依伺服器；沒有項目的分組不顯示） */
export function groupCapabilities(matrix) {
  return matrix.groups
    .map((g) => ({ ...g, items: matrix.capabilities.filter((c) => c.group === g.key) }))
    .filter((g) => g.items.length > 0);
}
