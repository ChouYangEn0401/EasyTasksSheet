/**
 * 讓非 React 程式（api 401 處理、openTask、閒置登出）也能導頁。
 * App 啟動時以 router.navigate 註冊；未註冊時退回整頁跳轉。
 */
type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;

let navigateImpl: NavigateFn | null = null;

export function registerNavigate(fn: NavigateFn) {
  navigateImpl = fn;
}

export function navigateTo(to: string, opts: { replace?: boolean } = {}) {
  if (navigateImpl) navigateImpl(to, opts);
  else if (opts.replace) window.location.replace(to);
  else window.location.assign(to);
}

/** 目前路徑（含 query，不含 hash） */
export const currentPath = () => window.location.pathname + window.location.search;

/** 登入頁網址；next 為登入後回到的路徑 */
export function loginUrl(opts: { reason?: 'expired'; next?: string } = {}): string {
  const sp = new URLSearchParams();
  if (opts.reason) sp.set('reason', opts.reason);
  if (opts.next && opts.next !== '/' && !opts.next.startsWith('/login')) sp.set('next', opts.next);
  const s = sp.toString();
  return s ? `/login?${s}` : '/login';
}

/** 只接受站內相對路徑，避免 open redirect */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/';
  return next;
}
