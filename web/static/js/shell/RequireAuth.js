import { createElement, Fragment } from 'preact';
import { Navigate, useLocation } from '../lib/router.js';
import { ForceChangePasswordPage } from '../features/auth/ForceChangePasswordPage.js';
import { isSessionEnding, useIdleSession, useMe } from '../lib/auth.js';
import { loginUrl } from '../lib/navigation.js';
import { ErrorState, Spinner } from '../ui/index.js';
import { AppShell } from './AppShell.js';

/**
 * 路由守衛：未登入導向 /login?next=<原路徑>；must_change_password 時改顯示強制變更密碼頁；
 * 其餘渲染 AppShell。已登入期間掛載閒置偵測。
 */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return createElement(
      'div',
      { className: 'full-center' },
      createElement(Spinner, { size: 20, label: '載入中' }),
    );
  }
  if (me.isError && me.data === undefined) {
    return createElement(
      'div',
      { className: 'full-center' },
      createElement(ErrorState, { error: me.error, onRetry: () => void me.refetch() }),
    );
  }
  if (!me.data) {
    if (isSessionEnding()) return null;
    return createElement(Navigate, {
      to: loginUrl({ next: location.pathname + location.search }),
      replace: true,
    });
  }
  return createElement(Authenticated, { mustChange: me.data.user.mustChangePassword });
}

function Authenticated({ mustChange }) {
  useIdleSession();
  return mustChange ? createElement(ForceChangePasswordPage, null) : createElement(AppShell, null);
}
