import { Navigate, useLocation } from 'react-router';
import { ForceChangePasswordPage } from '../features/auth/ForceChangePasswordPage.tsx';
import { isSessionEnding, useIdleSession, useMe } from '../lib/auth.ts';
import { loginUrl } from '../lib/navigation.ts';
import { ErrorState, Spinner } from '../ui/index.ts';
import { AppShell } from './AppShell.tsx';

/**
 * 路由守衛：未登入導向 /login?next=<原路徑>；must_change_password 時改顯示強制變更密碼頁；
 * 其餘渲染 AppShell。已登入期間掛載閒置偵測。
 */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="full-center">
        <Spinner size={20} label="載入中" />
      </div>
    );
  }
  if (me.isError && me.data === undefined) {
    return (
      <div className="full-center">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) {
    if (isSessionEnding()) return null;
    return <Navigate to={loginUrl({ next: location.pathname + location.search })} replace />;
  }
  return <Authenticated mustChange={me.data.user.mustChangePassword} />;
}

function Authenticated({ mustChange }: { mustChange: boolean }) {
  useIdleSession();
  return mustChange ? <ForceChangePasswordPage /> : <AppShell />;
}
