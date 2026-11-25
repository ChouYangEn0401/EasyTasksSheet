import { useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { useChangePassword } from '../../lib/auth.ts';
import { formatDateTime } from '../../lib/format.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Alert, Badge, Button, ErrorState, Field, Input, Skeleton } from '../../ui/index.ts';
import { PasswordInput } from '../auth/PasswordInput.tsx';
import { useProfile, useUpdateProfile } from './api.ts';
import {
  buildProfilePatch,
  canSubmitPassword,
  canSubmitProfile,
  MIN_PASSWORD,
  passwordStrength,
  profileChanges,
  roleLabel,
  validatePasswordForm,
  validateProfile,
  type Profile,
} from './model.ts';
import './settings.css';

const errorField = (err: unknown) =>
  (err instanceof ApiError && (err.details as { field?: string } | undefined)?.field) || '';

/** 個人設定（/settings，docs/design/settings.md）：個人資料、變更密碼、帳號資訊 */
export function SettingsPage() {
  const query = useProfile();
  return (
    <div className="settings-page">
      <p className="settings-sub">管理你自己的顯示名稱、登入帳號與密碼。</p>
      {query.isPending ? (
        <Skeleton height={220} />
      ) : query.isError || !query.data ? (
        <ErrorState error={query.error} title="無法載入個人設定" onRetry={() => void query.refetch()} />
      ) : (
        <>
          <ProfileCard profile={query.data} />
          <PasswordCard />
          <InfoCard profile={query.data} />
        </>
      )}
    </div>
  );
}

function ProfileCard({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState({
    displayName: profile.displayName,
    username: profile.username,
    currentPassword: '',
  });
  const mutation = useUpdateProfile();
  const [saved, setSaved] = useState(false);

  const changed = profileChanges(draft, profile);
  const errors = validateProfile(draft, profile);
  const serverField = mutation.isError ? errorField(mutation.error) : '';
  const serverMsg = mutation.isError ? errorMessage(mutation.error) : undefined;
  const fieldError = (f: 'displayName' | 'username' | 'currentPassword') =>
    (f !== 'currentPassword' ? errors[f] : undefined) ?? (serverField === f ? serverMsg : undefined);
  const formError = mutation.isError && !['displayName', 'username', 'currentPassword'].includes(serverField);
  const canSubmit = canSubmitProfile(draft, profile) && !mutation.isPending;

  const set = (key: keyof typeof draft) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setSaved(false);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(buildProfilePatch(draft, profile), {
      onSuccess: (p) => {
        setDraft({ displayName: p.displayName, username: p.username, currentPassword: '' });
        setSaved(true);
        notifySuccess('個人資料已更新');
      },
    });
  };

  return (
    <section className="settings-card" aria-labelledby="settings-profile-title">
      <header className="settings-card-head">
        <h3 id="settings-profile-title">個人資料</h3>
        <p>顯示名稱會出現在任務與成員清單；帳號用於登入。</p>
      </header>
      <form className="settings-form" onSubmit={submit} noValidate aria-label="個人資料">
        {formError && <Alert tone="danger">{serverMsg}</Alert>}
        <Field label="顯示名稱" error={fieldError('displayName')}>
          <Input
            value={draft.displayName}
            onChange={set('displayName')}
            autoComplete="name"
            disabled={mutation.isPending}
          />
        </Field>
        <Field
          label="帳號"
          hint="3–32 個英文字母、數字或 . _ -，以字母或數字開頭；輸入會轉成小寫"
          error={fieldError('username')}
        >
          <Input
            value={draft.username}
            onChange={set('username')}
            autoComplete="username"
            spellCheck={false}
            disabled={mutation.isPending}
          />
        </Field>
        {changed.username && (
          <Field
            label="目前密碼"
            hint="變更帳號前需輸入目前密碼確認是你本人；變更後請改用新帳號登入。"
            error={fieldError('currentPassword')}
          >
            <PasswordInput
              value={draft.currentPassword}
              onChange={set('currentPassword')}
              autoComplete="current-password"
              disabled={mutation.isPending}
            />
          </Field>
        )}
        <div className="settings-actions">
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={mutation.isPending}>
            儲存變更
          </Button>
          {saved && !changed.displayName && !changed.username && (
            <span className="settings-saved" role="status">
              已儲存
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

function PasswordCard() {
  const [draft, setDraft] = useState({ current: '', next: '', confirm: '' });
  const [done, setDone] = useState(false);
  const mutation = useChangePassword();

  const errors = validatePasswordForm(draft);
  const strength = passwordStrength(draft.next);
  const serverField = mutation.isError ? errorField(mutation.error) : '';
  const serverMsg = mutation.isError ? errorMessage(mutation.error) : undefined;
  const canSubmit = canSubmitPassword(draft) && !mutation.isPending;

  const set = (key: keyof typeof draft) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setDone(false);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      { currentPassword: draft.current, newPassword: draft.next },
      {
        onSuccess: () => {
          setDraft({ current: '', next: '', confirm: '' });
          setDone(true);
          notifySuccess('密碼已更新，其他裝置已登出');
        },
      },
    );
  };

  return (
    <section className="settings-card" aria-labelledby="settings-password-title">
      <header className="settings-card-head">
        <h3 id="settings-password-title">變更密碼</h3>
        <p>變更後，你在其他裝置的登入會被登出；目前這個畫面不受影響。</p>
      </header>
      <form className="settings-form" onSubmit={submit} noValidate aria-label="變更密碼">
        {done && <Alert tone="success">密碼已更新，其他裝置已登出。</Alert>}
        {mutation.isError && serverField !== 'newPassword' && <Alert tone="danger">{serverMsg}</Alert>}
        <Field label="目前密碼">
          <PasswordInput
            value={draft.current}
            onChange={set('current')}
            autoComplete="current-password"
            disabled={mutation.isPending}
          />
        </Field>
        <Field
          label="新密碼"
          hint={`至少 ${MIN_PASSWORD} 個字元，不可為 password，也不可與目前密碼相同`}
          error={errors.next ?? (serverField === 'newPassword' ? serverMsg : undefined)}
        >
          <PasswordInput
            value={draft.next}
            onChange={set('next')}
            autoComplete="new-password"
            disabled={mutation.isPending}
          />
        </Field>
        {strength.level > 0 && (
          <div className="settings-strength" data-level={strength.level} aria-live="polite">
            <span className="settings-strength-bar" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>密碼強度：{strength.label}</span>
          </div>
        )}
        <Field label="確認新密碼" error={errors.confirm}>
          <PasswordInput
            value={draft.confirm}
            onChange={set('confirm')}
            autoComplete="new-password"
            disabled={mutation.isPending}
          />
        </Field>
        <div className="settings-actions">
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={mutation.isPending}>
            更新密碼
          </Button>
        </div>
      </form>
    </section>
  );
}

function InfoCard({ profile }: { profile: Profile }) {
  return (
    <section className="settings-card" aria-labelledby="settings-info-title">
      <header className="settings-card-head">
        <h3 id="settings-info-title">帳號資訊</h3>
        <p>以下資料僅供檢視；角色由管理員調整。</p>
      </header>
      <dl className="settings-info">
        <div>
          <dt>角色</dt>
          <dd>
            <Badge tone="accent">{roleLabel(profile.role)}</Badge>
          </dd>
        </div>
        <div>
          <dt>建立時間</dt>
          <dd>{formatDateTime(profile.createdAt)}</dd>
        </div>
        {profile.lastLoginAt != null && (
          <div>
            <dt>最近登入</dt>
            <dd>{formatDateTime(profile.lastLoginAt)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
