import { useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../../lib/api.ts';
import { useChangePassword } from '../../lib/auth.ts';
import { Alert, Field } from '../../ui/index.ts';
import { PasswordInput } from './PasswordInput.tsx';

export const MIN_PASSWORD = 8;

/**
 * 變更密碼表單（Dialog 版與強制變更整頁版共用）。
 * 欄位未填齊、新密碼不足 8 字或兩次不一致時不可送出；API 錯誤顯示在表單上方。
 */
export function ChangePasswordForm({
  id,
  onSuccess,
  onDirtyChange,
  renderActions,
  size = 'md',
}: {
  id: string;
  onSuccess: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  renderActions: (state: { canSubmit: boolean; submitting: boolean }) => ReactNode;
  size?: 'md' | 'lg';
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const mutation = useChangePassword();

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit = !!current && next.length >= MIN_PASSWORD && confirm === next && !mutation.isPending;

  const update = (setter: (v: string) => void) => (e: { target: { value: string } }) => {
    setter(e.target.value);
    onDirtyChange?.(true);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          onDirtyChange?.(false);
          onSuccess();
        },
      },
    );
  };

  return (
    <form id={id} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {mutation.isError && <Alert tone="danger">{errorMessage(mutation.error)}</Alert>}
      <Field label="目前密碼">
        <PasswordInput
          size={size}
          autoComplete="current-password"
          value={current}
          onChange={update(setCurrent)}
          disabled={mutation.isPending}
          data-autofocus
        />
      </Field>
      <Field
        label="新密碼"
        hint={`至少 ${MIN_PASSWORD} 個字元`}
        error={tooShort ? `至少需要 ${MIN_PASSWORD} 個字元` : undefined}
      >
        <PasswordInput
          size={size}
          autoComplete="new-password"
          value={next}
          onChange={update(setNext)}
          disabled={mutation.isPending}
        />
      </Field>
      <Field label="確認新密碼" error={mismatch ? '兩次輸入的新密碼不一致' : undefined}>
        <PasswordInput
          size={size}
          autoComplete="new-password"
          value={confirm}
          onChange={update(setConfirm)}
          disabled={mutation.isPending}
        />
      </Field>
      {renderActions({ canSubmit, submitting: mutation.isPending })}
    </form>
  );
}
