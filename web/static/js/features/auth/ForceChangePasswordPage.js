import { createElement, Fragment } from 'preact';
import { logout, useMe } from '../../lib/auth.js';
import { Button } from '../../ui/index.js';
import { AuthCard } from './AuthCard.js';
import { ChangePasswordForm } from './ChangePasswordForm.js';

/**
 * must_change_password：整頁強制變更（無關閉、Esc 無效），只提供「更新」與「登出」。
 * 預設管理員首次登入（mustChangeUsername）須同時設定新帳號與新密碼。
 */
export function ForceChangePasswordPage() {
  const me = useMe().data;
  const changeUsername = me?.mustChangeUsername ? { current: me.user.username } : undefined;
  return createElement(
    AuthCard,
    {
      title: changeUsername ? '請設定新帳號與新密碼' : '請先設定新密碼',
      subtitle: changeUsername
        ? `你正使用預設管理員帳號 ${changeUsername.current} 登入，請改用自己的帳號與密碼後繼續使用。`
        : '這是你第一次登入或密碼已被重設，請設定新的密碼後繼續使用。',
    },
    createElement(ChangePasswordForm, {
      id: 'force-change-password',
      size: 'lg',
      changeUsername: changeUsername,
      onSuccess: () => undefined,
      renderActions: ({ canSubmit, submitting }) =>
        createElement(
          'div',
          { className: 'flex flex-col gap-2' },
          createElement(
            Button,
            {
              type: 'submit',
              variant: 'primary',
              size: 'lg',
              fullWidth: true,
              disabled: !canSubmit,
              loading: submitting,
            },
            changeUsername ? '更新帳號與密碼' : '更新密碼',
          ),
          createElement(
            Button,
            { variant: 'ghost', fullWidth: true, onClick: () => void logout(), disabled: submitting },
            '登出',
          ),
        ),
    }),
  );
}
