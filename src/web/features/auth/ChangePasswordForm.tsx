import { useState, type FormEvent, type ReactNode } from 'react';
import { adminUsername } from '../../../shared/admin.ts';
import { DEFAULT_ADMIN_PASSWORD } from '../../../shared/auth.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { useChangePassword } from '../../lib/auth.ts';
import { Alert, Field, Input } from '../../ui/index.ts';
import { PasswordInput } from './PasswordInput.tsx';

export const MIN_PASSWORD = 8;

const errorField = (err: unknown) =>
  (err instanceof ApiError && (err.details as { field?: string } | undefined)?.field) || '';

/**
 * 變更密碼表單（Dialog 版與強制變更整頁版共用）。
 * 欄位未填齊、新密碼不足 8 字或兩次不一致時不可送出；API 錯誤顯示在表單上方（帳號錯誤顯示在帳號欄位）。
 * changeUsername：預設管理員首次重設，另顯示「新帳號」欄位（預填目前帳號，須改成其他帳號）。
 */
export function ChangePasswordForm({
  id,
  onSuccess,
  onDirtyChange,
  renderActions,
  size = 'md',
  changeUsername,
}: {
  id: string;
  onSuccess: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  renderActions: (state: { canSubmit: boolean; submitting: boolean }) => ReactNode;
  size?: 'md' | 'lg';
  changeUsername?: { current: string };
}) {
  const [username, setUsername] = useState(changeUsername?.current ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const mutation = useChangePassword();

  const parsedUsername = changeUsername ? adminUsername.safeParse(username) : null;
  const usernameError = (() => {
    if (!changeUsername || !parsedUsername) return undefined;
    if (mutation.isError && errorField(mutation.error) === 'username') return errorMessage(mutation.error);
    if (username.trim() === '') return undefined;
    if (!parsedUsername.success) return parsedUsername.error.issues[0]?.message;
    if (parsedUsername.data === changeUsername.current) return `請改成 ${changeUsername.current} 以外的帳號`;
    return undefined;
  })();
  const usernameOk =
    !changeUsername || (parsedUsername?.success === true && parsedUsername.data !== changeUsername.current);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const isDefault = next === DEFAULT_ADMIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    usernameOk &&
    !!current &&
    next.length >= MIN_PASSWORD &&
    !isDefault &&
    confirm === next &&
    !mutation.isPending;

  const update = (setter: (v: string) => void) => (e: { target: { value: string } }) => {
    setter(e.target.value);
    onDirtyChange?.(true);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      {
        currentPassword: current,
        newPassword: next,
        ...(changeUsername && parsedUsername?.success ? { username: parsedUsername.data } : {}),
      },
      {
        onSuccess: () => {
          onDirtyChange?.(false);
          onSuccess();
        },
      },
    );
  };

  const formError =
    mutation.isError && !(changeUsername && errorField(mutation.error) === 'username')
      ? errorMessage(mutation.error)
      : undefined;

  return (
    <form id={id} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {formError && <Alert tone="danger">{formError}</Alert>}
      {changeUsername && (
        <Field label="新帳號" hint="之後以此帳號登入" error={usernameError}>
          <Input
            size={size}
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={update(setUsername)}
            disabled={mutation.isPending}
            invalid={!!usernameError}
            data-autofocus
          />
        </Field>
      )}
      <Field label="目前密碼">
        <PasswordInput
          size={size}
          autoComplete="current-password"
          value={current}
          onChange={update(setCurrent)}
          disabled={mutation.isPending}
          data-autofocus={changeUsername ? undefined : true}
        />
      </Field>
      <Field
        label="新密碼"
        hint={`至少 ${MIN_PASSWORD} 個字元`}
        error={tooShort ? `至少需要 ${MIN_PASSWORD} 個字元` : isDefault ? '不可使用預設密碼' : undefined}
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
