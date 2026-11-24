import { logout } from '../../lib/auth.ts';
import { Button } from '../../ui/index.ts';
import { AuthCard } from './AuthCard.tsx';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';

/** must_change_password：整頁強制變更（無關閉、Esc 無效），只提供「更新密碼」與「登出」 */
export function ForceChangePasswordPage() {
  return (
    <AuthCard title="請先設定新密碼" subtitle="這是你第一次登入或密碼已被重設，請設定新的密碼後繼續使用。">
      <ChangePasswordForm
        id="force-change-password"
        size="lg"
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
              更新密碼
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
