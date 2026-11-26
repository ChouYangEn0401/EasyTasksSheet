import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { ChangePasswordForm } from '../features/auth/ChangePasswordForm.js';
import { Button, Dialog } from '../ui/index.js';

const FORM_ID = 'change-password-form';

/** 變更密碼 Dialog（使用者選單開啟）；成功後關閉並由 shell 顯示頁內成功提示列 */
export function ChangePasswordDialog({ open, onClose, onSuccess }) {
  const [dirty, setDirty] = useState(false);
  const close = () => {
    setDirty(false);
    onClose();
  };
  return createElement(
    Dialog,
    { open: open, onClose: close, title: '變更密碼', dirty: dirty },
    open &&
      createElement(ChangePasswordForm, {
        id: FORM_ID,
        onDirtyChange: setDirty,
        onSuccess: () => {
          close();
          onSuccess();
        },
        renderActions: ({ canSubmit, submitting }) =>
          createElement(
            'div',
            { className: 'ui-dialog-actions', style: { margin: '4px -24px -20px' } },
            createElement(Button, { variant: 'secondary', onClick: close, disabled: submitting }, '取消'),
            createElement(
              Button,
              { type: 'submit', variant: 'primary', disabled: !canSubmit, loading: submitting },
              '更新密碼',
            ),
          ),
      }),
  );
}
