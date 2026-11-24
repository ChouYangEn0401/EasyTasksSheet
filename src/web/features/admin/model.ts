import type { AdminUser } from '../../../shared/admin.ts';
import type { UserRole } from '../../../shared/users.ts';
import { errorMessage } from '../../lib/api.ts';

export const ROLE_LABELS: Record<UserRole, string> = { admin: '管理員', member: '成員' };

/** 頁面提示列的回報函式（成功 / 失敗文案由頁面組合） */
export type Notify = (tone: 'success' | 'danger', message: string) => void;

export const failText = (err: unknown) => `無法完成操作：${errorMessage(err)}`;

/** 狀態篩選（URL ?state=） */
export const STATE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '啟用' },
  { value: 'disabled', label: '已停用' },
] as const;
export type StateFilter = (typeof STATE_FILTERS)[number]['value'];

export type AdminFilters = { q: string; state: StateFilter };

export function readFilters(sp: URLSearchParams): AdminFilters {
  const state = sp.get('state');
  return {
    q: sp.get('q') ?? '',
    state: STATE_FILTERS.some((s) => s.value === state) ? (state as StateFilter) : 'all',
  };
}

/** 寫回 URL（預設值不寫入） */
export function writeFilters(sp: URLSearchParams, f: AdminFilters): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (f.q) next.set('q', f.q);
  else next.delete('q');
  if (f.state !== 'all') next.set('state', f.state);
  else next.delete('state');
  return next;
}

export const hasFilters = (f: AdminFilters) => f.q.trim() !== '' || f.state !== 'all';

/** 主狀態：已停用 > 已鎖定 > 啟用 */
export type RowState = 'active' | 'locked' | 'disabled';
export function rowState(u: AdminUser, now: number): RowState {
  if (!u.isActive) return 'disabled';
  if (u.lockedUntil != null && u.lockedUntil > now) return 'locked';
  return 'active';
}

/** 已鎖定 Badge 的 tooltip */
export function lockTooltip(u: AdminUser, now: number): string {
  const base = '登入失敗次數過多，暫時無法登入';
  if (u.lockedUntil == null || u.lockedUntil <= now) return base;
  const minutes = Math.max(1, Math.ceil((u.lockedUntil - now) / 60_000));
  return `${base}，約 ${minutes} 分鐘後自動解除`;
}

/** 排序：啟用中在前、停用在後；同組內管理員優先，再依顯示名稱 */
export function sortUsers(list: readonly AdminUser[]): AdminUser[] {
  return [...list].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      Number(b.role === 'admin') - Number(a.role === 'admin') ||
      a.displayName.localeCompare(b.displayName, 'zh-Hant') ||
      a.id - b.id,
  );
}

/** 前端過濾：關鍵字比對顯示名稱與帳號（不分大小寫）、狀態 */
export function filterUsers(list: readonly AdminUser[], f: AdminFilters): AdminUser[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((u) => {
    if (f.state === 'active' && !u.isActive) return false;
    if (f.state === 'disabled' && u.isActive) return false;
    if (!q) return true;
    return u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
  });
}
