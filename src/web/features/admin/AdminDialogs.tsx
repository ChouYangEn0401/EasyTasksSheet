import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  adminUsername,
  isLastActiveAdmin,
  LAST_ADMIN_MESSAGE,
  type AdminUser,
} from '../../../shared/admin.ts';
import type { UserRole } from '../../../shared/users.ts';
import { ApiError } from '../../lib/api.ts';
import { Alert, Button, Dialog, Field, Input, Select, type SelectOption } from '../../ui/index.ts';
import { useCreateAdminUser, useResetPassword, useUpdateAdminUser } from './api.ts';
import { failText, ROLE_LABELS, type Notify } from './model.ts';

const roleOptions = (lockAdmin: boolean): SelectOption<UserRole>[] => [
  { value: 'member', label: ROLE_LABELS.member, disabled: lockAdmin },
  { value: 'admin', label: ROLE_LABELS.admin },
];

// ── 臨時密碼結果面板（新增、重設共用） ─────────────────────────

function TempPasswordResult({
  password,
  note,
  announce,
  onDone,
}: {
  password: string;
  note?: string;
  announce: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // 面板出現時 focus 移到「複製」（同一個 Dialog 由表單切換而來，Dialog 不會重新自動聚焦）
  useEffect(() => {
    copyRef.current?.focus();
    return () => window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
    } catch {
      // 不支援 Clipboard API（非安全來源）時改用選取 + execCommand
      const range = document.createRange();
      if (codeRef.current) range.selectNodeContents(codeRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand('copy');
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="adm-result">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="x"
        aria-label="關閉"
        className="adm-result-close"
        onClick={onDone}
      />
      <span className="sr-only" aria-live="assertive">
        {announce}
      </span>
      <span className="ui-label">臨時密碼</span>
      <div className="adm-password">
        <code ref={codeRef} className="adm-password-text" aria-label="臨時密碼">
          {password}
        </code>
        <Button ref={copyRef} variant="secondary" size="sm" data-autofocus onClick={() => void copy()}>
          {copied ? '已複製' : '複製'}
        </Button>
      </div>
      <Alert tone="warning" role="status">
        此密碼只會顯示這一次，請立即轉交本人。{note}
      </Alert>
    </div>
  );
}

const DoneButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="primary" onClick={onClick}>
    完成
  </Button>
);

// ── 新增成員 ────────────────────────────────────────────────

export function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateAdminUser();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [usernameError, setUsernameError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [result, setResult] = useState<{ name: string; password: string } | null>(null);

  const canSubmit = username.trim() !== '' && displayName.trim() !== '' && !create.isPending;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    const parsed = adminUsername.safeParse(username);
    if (!parsed.success) {
      setUsernameError(parsed.error.issues[0]?.message);
      return;
    }
    setUsernameError(undefined);
    setFormError(undefined);
    create.mutate(
      { username: parsed.data, displayName: displayName.trim(), role },
      {
        onSuccess: (res) => setResult({ name: res.user.displayName, password: res.tempPassword }),
        onError: (err) => {
          const field =
            (err instanceof ApiError && (err.details as { field?: string } | undefined)?.field) || '';
          if (field === 'username') setUsernameError(err.message);
          else setFormError(failText(err));
        },
      },
    );
  };

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        dismissible={false}
        title={`已建立成員「${result.name}」`}
        actions={<DoneButton onClick={onClose} />}
      >
        <TempPasswordResult
          password={result.password}
          announce="已建立成員，臨時密碼已顯示"
          onDone={onClose}
        />
      </Dialog>
    );
  }

  const dirty = username !== '' || displayName !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      title="新增成員"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="adm-create-form"
            variant="primary"
            disabled={!canSubmit}
            loading={create.isPending}
          >
            建立
          </Button>
        </>
      }
    >
      <form id="adm-create-form" className="adm-form" onSubmit={submit} noValidate>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="帳號" hint="登入用，建立後無法修改" error={usernameError}>
          <Input
            autoComplete="off"
            spellCheck={false}
            value={username}
            data-autofocus
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameError(undefined);
            }}
          />
        </Field>
        <Field label="顯示名稱" hint="顯示在任務與頭像上">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="角色">
          <Select<UserRole> value={role} onChange={setRole} options={roleOptions(false)} />
        </Field>
        <Alert tone="info">建立後會產生一組臨時密碼，成員首次登入時須自行變更。</Alert>
      </form>
    </Dialog>
  );
}

// ── 編輯成員 ────────────────────────────────────────────────

export function EditUserDialog({
  user,
  all,
  meId,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  all: readonly AdminUser[];
  meId: number;
  onClose: () => void;
  /** 儲存成功（selfDemoted：自己降為成員，頁面需立即離開） */
  onSaved: (user: AdminUser, selfDemoted: boolean) => void;
}) {
  const update = useUpdateAdminUser();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<UserRole>(user.role);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string>();
  const lockAdmin = isLastActiveAdmin(user, all);

  const patch: { displayName?: string; role?: UserRole } = {};
  if (displayName.trim() !== user.displayName) patch.displayName = displayName.trim();
  if (role !== user.role) patch.role = role;
  const dirty = Object.keys(patch).length > 0;
  const nameError = displayName.trim() ? undefined : '請輸入顯示名稱';
  const selfDemote = user.id === meId && patch.role === 'member';

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty || nameError || update.isPending) return;
    if (selfDemote && !confirming) {
      setConfirming(true);
      return;
    }
    setFormError(undefined);
    update.mutate(
      { id: user.id, ...patch },
      {
        onSuccess: (saved) => onSaved(saved, selfDemote),
        onError: (err) => {
          setConfirming(false);
          setFormError(failText(err));
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      title="編輯成員"
      actions={
        <>
          <Button variant="secondary" onClick={confirming ? () => setConfirming(false) : onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="adm-edit-form"
            variant={confirming ? 'danger' : 'primary'}
            disabled={!dirty || !!nameError}
            loading={update.isPending}
          >
            {confirming ? '確定降級' : '儲存'}
          </Button>
        </>
      }
    >
      <form id="adm-edit-form" className="adm-form" onSubmit={submit} noValidate>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="帳號">
          <Input value={user.username} readOnly className="adm-readonly" />
        </Field>
        <Field label="顯示名稱" error={nameError}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="角色" hint={lockAdmin ? LAST_ADMIN_MESSAGE : undefined}>
          <Select<UserRole>
            value={role}
            onChange={(v) => {
              setRole(v);
              setConfirming(false);
            }}
            options={roleOptions(lockAdmin)}
          />
        </Field>
        {confirming && <Alert tone="warning">你將失去管理權限，並立即離開此頁面。</Alert>}
      </form>
    </Dialog>
  );
}

// ── 重設密碼（確認 → 結果） ────────────────────────────────

export function ResetPasswordDialog({
  user,
  onClose,
  notify,
}: {
  user: AdminUser;
  onClose: () => void;
  notify: Notify;
}) {
  const reset = useResetPassword();
  const [password, setPassword] = useState<string | null>(null);

  if (password) {
    return (
      <Dialog
        open
        onClose={onClose}
        dismissible={false}
        title={`已重設「${user.displayName}」的密碼`}
        actions={<DoneButton onClick={onClose} />}
      >
        <TempPasswordResult
          password={password}
          note="該成員下次登入時須設定新密碼。"
          announce="已重設密碼，臨時密碼已顯示"
          onDone={onClose}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`重設「${user.displayName}」的密碼？`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={reset.isPending}
            onClick={() =>
              reset.mutate(user.id, {
                onSuccess: (res) => setPassword(res.tempPassword),
                onError: (err) => {
                  notify('danger', failText(err));
                  onClose();
                },
              })
            }
          >
            重設密碼
          </Button>
        </>
      }
    >
      <p className="adm-text">會產生新的臨時密碼，原密碼立即失效。</p>
    </Dialog>
  );
}

// ── 停用確認 ────────────────────────────────────────────────

export function DisableUserDialog({
  user,
  isSelf,
  onClose,
  onDisabled,
  notify,
}: {
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  onDisabled: (user: AdminUser) => void;
  notify: Notify;
}) {
  const update = useUpdateAdminUser();
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={`停用「${user.displayName}」？`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { id: user.id, isActive: false },
                {
                  onSuccess: onDisabled,
                  onError: (err) => {
                    notify('danger', failText(err));
                    onClose();
                  },
                },
              )
            }
          >
            停用
          </Button>
        </>
      }
    >
      <p className="adm-text">
        停用後無法登入，目前的登入狀態會立即失效。此成員的任務與紀錄都會保留，之後可重新啟用。
      </p>
      {isSelf && <p className="adm-text">你將立即被登出。</p>}
    </Dialog>
  );
}
