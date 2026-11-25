import { logout, useMe } from '../../lib/auth.ts';
import { Button } from '../../ui/index.ts';
import { AuthCard } from './AuthCard.tsx';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/**
 * must_change_password：整頁強制變更（無關閉、Esc 無效），只提供「更新」與「登出」。
 * 預設管理員首次登入（mustChangeUsername）須同時設定新帳號與新密碼。
 */
export function ForceChangePasswordPage() {
  const me = useMe().data;
  const changeUsername = me?.mustChangeUsername ? { current: me.user.username } : undefined;
  return (
    <AuthCard
      title={changeUsername ? '請設定新帳號與新密碼' : '請先設定新密碼'}
      subtitle={
        changeUsername
          ? `你正使用預設管理員帳號 ${changeUsername.current} 登入，請改用自己的帳號與密碼後繼續使用。`
          : '這是你第一次登入或密碼已被重設，請設定新的密碼後繼續使用。'
      }
    >
      <ChangePasswordForm
        id="force-change-password"
        size="lg"
        changeUsername={changeUsername}
        onSuccess={() => undefined}
        renderActions={({ canSubmit, submitting }) => (
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              disabled={!canSubmit}
              loading={submitting}
            >
              {changeUsername ? '更新帳號與密碼' : '更新密碼'}
            </Button>
            <Button variant="ghost" fullWidth onClick={() => void logout()} disabled={submitting}>
              登出
            </Button>
          </div>
        )}
      />
    </AuthCard>
  );
}
