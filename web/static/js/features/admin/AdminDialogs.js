import { createElement, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/compat';
import {
  adminUsername,
  IN_OVERVIEW_HINT,
  isLastActiveRoot,
  LAST_ROOT_MESSAGE,
} from '../../shared/admin.js';
import { ApiError } from '../../lib/api.js';
import { useCan } from '../../lib/permissions.js';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '../../ui/index.js';
import { useCreateAdminUser, useResetPassword, useUpdateAdminUser } from './api.js';
import { failText, ROLE_LABELS, roleChoices } from './model.js';

/** 三層角色下拉：manager 不能指派 root；最後一位 root 不能降級 */
const roleOptions = (canAssignRoot, lockRoot) =>
  roleChoices({ canAssignRoot, lockRoot }).map((c) => ({
    value: c.value,
    label: ROLE_LABELS[c.value],
    disabled: c.disabled,
  }));

const ROLE_HINT_MANAGER = '只有超級管理員可以指派超級管理員';

// ── 臨時密碼結果面板（新增、重設共用） ─────────────────────────

function TempPasswordResult({ password, note, announce, onDone }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);
  const copyRef = useRef(null);
  const timer = useRef(undefined);
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

  return createElement(
    'div',
    { className: 'adm-result' },
    createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      iconOnly: true,
      icon: 'x',
      'aria-label': '關閉',
      className: 'adm-result-close',
      onClick: onDone,
    }),
    createElement('span', { className: 'sr-only', 'aria-live': 'assertive' }, announce),
    createElement('span', { className: 'ui-label' }, '臨時密碼'),
    createElement(
      'div',
      { className: 'adm-password' },
      createElement(
        'code',
        { ref: codeRef, className: 'adm-password-text', 'aria-label': '臨時密碼' },
        password,
      ),
      createElement(
        Button,
        {
          ref: copyRef,
          variant: 'secondary',
          size: 'sm',
          'data-autofocus': true,
          onClick: () => void copy(),
        },
        copied ? '已複製' : '複製',
      ),
    ),
    createElement(Alert, { tone: 'warning', role: 'status' }, '此密碼只會顯示這一次，請立即轉交本人。', note),
  );
}

const DoneButton = ({ onClick }) => createElement(Button, { variant: 'primary', onClick: onClick }, '完成');

/** 「列入總覽統計」開關（新增 / 編輯共用） */
function InOverviewField({ checked, onChange }) {
  return createElement(
    Field,
    { label: '總覽', hint: IN_OVERVIEW_HINT },
    createElement(Checkbox, {
      label: '列入總覽統計',
      checked: checked,
      onChange: (e) => onChange(e.target.checked),
      'data-testid': 'in-overview-toggle',
    }),
  );
}

// ── 新增成員 ────────────────────────────────────────────────

export function CreateUserDialog({ onClose }) {
  const create = useCreateAdminUser();
  const canAssignRoot = useCan('roles.assign_root');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('user');
  // 預設依角色：root 不列入，其餘列入；使用者手動改過後不再隨角色變動
  const [inOverviewPick, setInOverviewPick] = useState();
  const inOverview = inOverviewPick ?? role !== 'root';
  const [usernameError, setUsernameError] = useState();
  const [formError, setFormError] = useState();
  const [result, setResult] = useState(null);

  const canSubmit = username.trim() !== '' && displayName.trim() !== '' && !create.isPending;

  const submit = (e) => {
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
      { username: parsed.data, displayName: displayName.trim(), role, inOverview },
      {
        onSuccess: (res) => setResult({ name: res.user.displayName, password: res.tempPassword }),
        onError: (err) => {
          const field = (err instanceof ApiError && err.details?.field) || '';
          if (field === 'username') setUsernameError(err.message);
          else setFormError(failText(err));
        },
      },
    );
  };

  if (result) {
    return createElement(
      Dialog,
      {
        open: true,
        onClose: onClose,
        dismissible: false,
        title: `已建立成員「${result.name}」`,
        actions: createElement(DoneButton, { onClick: onClose }),
      },
      createElement(TempPasswordResult, {
        password: result.password,
        announce: '已建立成員，臨時密碼已顯示',
        onDone: onClose,
      }),
    );
  }

  const dirty = username !== '' || displayName !== '';
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      dirty: dirty,
      title: '新增成員',
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            type: 'submit',
            form: 'adm-create-form',
            variant: 'primary',
            disabled: !canSubmit,
            loading: create.isPending,
          },
          '建立',
        ),
      ),
    },
    createElement(
      'form',
      { id: 'adm-create-form', className: 'adm-form', onSubmit: submit, noValidate: true },
      formError && createElement(Alert, { tone: 'danger' }, formError),
      createElement(
        Field,
        { label: '帳號', hint: '登入用，建立後無法修改', error: usernameError },
        createElement(Input, {
          autoComplete: 'off',
          spellCheck: false,
          value: username,
          'data-autofocus': true,
          onChange: (e) => {
            setUsername(e.target.value);
            setUsernameError(undefined);
          },
        }),
      ),
      createElement(
        Field,
        { label: '顯示名稱', hint: '顯示在任務與頭像上' },
        createElement(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value) }),
      ),
      createElement(
        Field,
        { label: '角色', hint: canAssignRoot ? undefined : ROLE_HINT_MANAGER },
        createElement(Select, { value: role, onChange: setRole, options: roleOptions(canAssignRoot, false) }),
      ),
      createElement(InOverviewField, { checked: inOverview, onChange: setInOverviewPick }),
      createElement(Alert, { tone: 'info' }, '建立後會產生一組臨時密碼，成員首次登入時須自行變更。'),
    ),
  );
}

// ── 編輯成員 ────────────────────────────────────────────────

export function EditUserDialog({ user, all, meId, onClose, onSaved }) {
  const update = useUpdateAdminUser();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [inOverview, setInOverview] = useState(user.inOverview);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState();
  const canAssignRoot = useCan('roles.assign_root');
  const lockRoot = isLastActiveRoot(user, all);

  const patch = {};
  if (displayName.trim() !== user.displayName) patch.displayName = displayName.trim();
  if (role !== user.role) patch.role = role;
  if (inOverview !== user.inOverview) patch.inOverview = inOverview;
  const dirty = Object.keys(patch).length > 0;
  const nameError = displayName.trim() ? undefined : '請輸入顯示名稱';
  // 自己降為 user 即失去成員管理權限
  const selfDemote = user.id === meId && patch.role === 'user';
  const roleHint = lockRoot ? LAST_ROOT_MESSAGE : canAssignRoot ? undefined : ROLE_HINT_MANAGER;

  const submit = (e) => {
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

  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      dirty: dirty,
      title: '編輯成員',
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          { variant: 'secondary', onClick: confirming ? () => setConfirming(false) : onClose },
          '取消',
        ),
        createElement(
          Button,
          {
            type: 'submit',
            form: 'adm-edit-form',
            variant: confirming ? 'danger' : 'primary',
            disabled: !dirty || !!nameError,
            loading: update.isPending,
          },
          confirming ? '確定降級' : '儲存',
        ),
      ),
    },
    createElement(
      'form',
      { id: 'adm-edit-form', className: 'adm-form', onSubmit: submit, noValidate: true },
      formError && createElement(Alert, { tone: 'danger' }, formError),
      createElement(
        Field,
        { label: '帳號' },
        createElement(Input, { value: user.username, readOnly: true, className: 'adm-readonly' }),
      ),
      createElement(
        Field,
        { label: '顯示名稱', error: nameError },
        createElement(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value) }),
      ),
      createElement(
        Field,
        { label: '角色', hint: roleHint },
        createElement(Select, {
          value: role,
          onChange: (v) => {
            setRole(v);
            // 改為 root 時一併不列入總覽統計（可再手動開啟）；改為非 root 不自動變更
            if (v === 'root' && user.role !== 'root') setInOverview(false);
            else if (v === user.role) setInOverview(user.inOverview);
            setConfirming(false);
          },
          options: roleOptions(canAssignRoot, lockRoot),
        }),
      ),
      createElement(InOverviewField, { checked: inOverview, onChange: setInOverview }),
      confirming && createElement(Alert, { tone: 'warning' }, '你將失去管理權限，並立即離開此頁面。'),
    ),
  );
}

// ── 重設密碼（確認 → 結果） ────────────────────────────────

export function ResetPasswordDialog({ user, onClose, notify }) {
  const reset = useResetPassword();
  const [password, setPassword] = useState(null);

  if (password) {
    return createElement(
      Dialog,
      {
        open: true,
        onClose: onClose,
        dismissible: false,
        title: `已重設「${user.displayName}」的密碼`,
        actions: createElement(DoneButton, { onClick: onClose }),
      },
      createElement(TempPasswordResult, {
        password: password,
        note: '該成員下次登入時須設定新密碼。',
        announce: '已重設密碼，臨時密碼已顯示',
        onDone: onClose,
      }),
    );
  }

  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      title: `重設「${user.displayName}」的密碼？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'primary',
            loading: reset.isPending,
            onClick: () =>
              reset.mutate(user.id, {
                onSuccess: (res) => setPassword(res.tempPassword),
                onError: (err) => {
                  notify('danger', failText(err));
                  onClose();
                },
              }),
          },
          '重設密碼',
        ),
      ),
    },
    createElement('p', { className: 'adm-text' }, '會產生新的臨時密碼，原密碼立即失效。'),
  );
}

// ── 停用確認 ────────────────────────────────────────────────

export function DisableUserDialog({ user, isSelf, onClose, onDisabled, notify }) {
  const update = useUpdateAdminUser();
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      role: 'alertdialog',
      title: `停用「${user.displayName}」？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'danger',
            loading: update.isPending,
            onClick: () =>
              update.mutate(
                { id: user.id, isActive: false },
                {
                  onSuccess: onDisabled,
                  onError: (err) => {
                    notify('danger', failText(err));
                    onClose();
                  },
                },
              ),
          },
          '停用',
        ),
      ),
    },
    createElement(
      'p',
      { className: 'adm-text' },
      '停用後無法登入，目前的登入狀態會立即失效。此成員的任務與紀錄都會保留，之後可重新啟用。',
    ),
    isSelf && createElement('p', { className: 'adm-text' }, '你將立即被登出。'),
  );
}
