import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../lib/api.ts';
import { useLogin, useMe } from '../../lib/auth.ts';
import { safeNext } from '../../lib/navigation.ts';
import { useSetupStatus } from '../../lib/sitePack.ts';
import { Alert, Button, Field, Input, Spinner } from '../../ui/index.ts';
import { AuthCard } from './AuthCard.tsx';
import { PasswordInput } from './PasswordInput.tsx';
import { SetupRestorePanel } from './SetupRestorePanel.tsx';

type Notice = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

/** 登入頁（/login）：無註冊、無忘記密碼連結 */
export function LoginPage() {
  const [sp] = useSearchParams();
  const next = safeNext(sp.get('next'));
  const me = useMe();
  const navigate = useNavigate();
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<Notice>(() =>
    sp.get('reason') === 'expired'
      ? { tone: 'info', text: '登入已逾時，請重新登入' }
      : sp.get('reason') === 'restored'
        ? { tone: 'info', text: '已用整站搬家包還原，請用搬家包裡的帳號密碼登入' }
        : null,
  );
  const setup = useSetupStatus(!me.data);
  const [showRestore, setShowRestore] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  // 鎖定期間按鈕停用，期滿自動解除
  useEffect(() => {
    if (lockedUntil == null) return;
    const ms = lockedUntil - Date.now();
    const t = window.setTimeout(() => setLockedUntil(null), Math.max(0, ms));
    return () => window.clearTimeout(t);
  }, [lockedUntil]);

  if (me.isPending) {
    return (
      <div className="full-center">
        <Spinner size={20} label="載入中" />
      </div>
    );
  }
  if (me.data && !login.isPending) return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return userRef.current?.focus();
    if (!password) return passRef.current?.focus();
    login.mutate(
      { username: username.trim(), password },
      {
        onSuccess: () => navigate(next, { replace: true }),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 429) {
            const seconds =
              (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 15 * 60;
            setLockedUntil(Date.now() + seconds * 1000);
            setNotice({
              tone: 'warning',
              text: `嘗試次數過多，請於 ${Math.max(1, Math.ceil(seconds / 60))} 分鐘後再試`,
            });
          } else if (err instanceof ApiError && err.status === 401) {
            setNotice({ tone: 'danger', text: '帳號或密碼不正確' });
            setPassword('');
            requestAnimationFrame(() => passRef.current?.focus());
          } else if (err instanceof ApiError && err.isNetwork) {
            setNotice({ tone: 'danger', text: '無法連線到伺服器' });
          } else {
            setNotice({ tone: 'danger', text: err.message || '登入失敗，請稍後再試' });
          }
        },
      },
    );
  };

  const busy = login.isPending;
  return (
    <AuthCard
      title="登入"
      subtitle="實驗室專案管理工具"
      footer={
        <div className="flex flex-col items-center gap-2">
          {setup.data?.pristine && !showRestore && (
            <Button variant="ghost" size="sm" icon="inbox" onClick={() => setShowRestore(true)}>
              全新安裝？從整站搬家包還原
            </Button>
          )}
          <p className="m-0 text-xs text-tertiary">忘記密碼請洽管理員</p>
        </div>
      }
    >
      {showRestore && setup.data?.pristine && (
        <SetupRestorePanel
          maxUploadMb={setup.data.maxUploadMb}
          onDone={(r) => {
            setShowRestore(false);
            setNotice({
              tone: 'info',
              text: `還原完成（帳號 ${r.counts.users}、任務 ${r.counts.tasks}、附件 ${r.counts.attachments}），請用搬家包裡的帳號密碼登入`,
            });
          }}
        />
      )}
      {notice && (
        <Alert tone={notice.tone} role="alert">
          {notice.text}
        </Alert>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="帳號">
          <Input
            ref={userRef}
            size="lg"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            name="username"
          />
        </Field>
        <Field label="密碼">
          <PasswordInput
            ref={passRef}
            size="lg"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            name="password"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={busy}
          disabled={lockedUntil != null}
        >
          登入
        </Button>
      </form>
    </AuthCard>
  );
}
