import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { ApiError, errorMessage } from '../../lib/api.js';
import { useAppInfo } from '../../lib/appInfo.js';
import { useChangePassword } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';
import { notifySuccess } from '../../lib/toast.js';
import { Alert, Badge, Button, ErrorState, Field, Input, Skeleton } from '../../ui/index.js';
import { PasswordInput } from '../auth/PasswordInput.js';
import { useProfile, useUpdateProfile } from './api.js';
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
} from './model.js';

const errorField = (err) => (err instanceof ApiError && err.details?.field) || '';

/** 個人設定（/settings，docs/design/settings.md）：個人資料、變更密碼、帳號資訊、整合（規劃中）、關於 */
export function SettingsPage() {
  const query = useProfile();
  return createElement(
    'div',
    { className: 'settings-page' },
    createElement('p', { className: 'settings-sub' }, '管理你自己的顯示名稱、登入帳號與密碼。'),
    query.isPending
      ? createElement(Skeleton, { height: 220 })
      : query.isError || !query.data
        ? createElement(ErrorState, {
            error: query.error,
            title: '無法載入個人設定',
            onRetry: () => void query.refetch(),
          })
        : createElement(
            Fragment,
            null,
            createElement(ProfileCard, { profile: query.data }),
            createElement(PasswordCard, null),
            createElement(InfoCard, { profile: query.data }),
            createElement(IntegrationsCard, null),
            createElement(AboutCard, null),
          ),
  );
}

function ProfileCard({ profile }) {
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
  const fieldError = (f) =>
    (f !== 'currentPassword' ? errors[f] : undefined) ?? (serverField === f ? serverMsg : undefined);
  const formError = mutation.isError && !['displayName', 'username', 'currentPassword'].includes(serverField);
  const canSubmit = canSubmitProfile(draft, profile) && !mutation.isPending;

  const set = (key) => (e) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setSaved(false);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e) => {
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

  return createElement(
    'section',
    { className: 'settings-card', 'aria-labelledby': 'settings-profile-title' },
    createElement(
      'header',
      { className: 'settings-card-head' },
      createElement('h3', { id: 'settings-profile-title' }, '個人資料'),
      createElement('p', null, '顯示名稱會出現在任務與成員清單；帳號用於登入。'),
    ),
    createElement(
      'form',
      { className: 'settings-form', onSubmit: submit, noValidate: true, 'aria-label': '個人資料' },
      formError && createElement(Alert, { tone: 'danger' }, serverMsg),
      createElement(
        Field,
        { label: '顯示名稱', error: fieldError('displayName') },
        createElement(Input, {
          value: draft.displayName,
          onChange: set('displayName'),
          autoComplete: 'name',
          disabled: mutation.isPending,
        }),
      ),
      createElement(
        Field,
        {
          label: '帳號',
          hint: '3–32 個英文字母、數字或 . _ -，以字母或數字開頭；輸入會轉成小寫',
          error: fieldError('username'),
        },
        createElement(Input, {
          value: draft.username,
          onChange: set('username'),
          autoComplete: 'username',
          spellCheck: false,
          disabled: mutation.isPending,
        }),
      ),
      changed.username &&
        createElement(
          Field,
          {
            label: '目前密碼',
            hint: '變更帳號前需輸入目前密碼確認是你本人；變更後請改用新帳號登入。',
            error: fieldError('currentPassword'),
          },
          createElement(PasswordInput, {
            value: draft.currentPassword,
            onChange: set('currentPassword'),
            autoComplete: 'current-password',
            disabled: mutation.isPending,
          }),
        ),
      createElement(
        'div',
        { className: 'settings-actions' },
        createElement(
          Button,
          { type: 'submit', variant: 'primary', disabled: !canSubmit, loading: mutation.isPending },
          '儲存變更',
        ),
        saved &&
          !changed.displayName &&
          !changed.username &&
          createElement('span', { className: 'settings-saved', role: 'status' }, '已儲存'),
      ),
    ),
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

  const set = (key) => (e) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setDone(false);
    if (mutation.isError) mutation.reset();
  };

  const submit = (e) => {
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

  return createElement(
    'section',
    { className: 'settings-card', 'aria-labelledby': 'settings-password-title' },
    createElement(
      'header',
      { className: 'settings-card-head' },
      createElement('h3', { id: 'settings-password-title' }, '變更密碼'),
      createElement('p', null, '變更後，你在其他裝置的登入會被登出；目前這個畫面不受影響。'),
    ),
    createElement(
      'form',
      { className: 'settings-form', onSubmit: submit, noValidate: true, 'aria-label': '變更密碼' },
      done && createElement(Alert, { tone: 'success' }, '密碼已更新，其他裝置已登出。'),
      mutation.isError &&
        serverField !== 'newPassword' &&
        createElement(Alert, { tone: 'danger' }, serverMsg),
      createElement(
        Field,
        { label: '目前密碼' },
        createElement(PasswordInput, {
          value: draft.current,
          onChange: set('current'),
          autoComplete: 'current-password',
          disabled: mutation.isPending,
        }),
      ),
      createElement(
        Field,
        {
          label: '新密碼',
          hint: `至少 ${MIN_PASSWORD} 個字元，不可為 password，也不可與目前密碼相同`,
          error: errors.next ?? (serverField === 'newPassword' ? serverMsg : undefined),
        },
        createElement(PasswordInput, {
          value: draft.next,
          onChange: set('next'),
          autoComplete: 'new-password',
          disabled: mutation.isPending,
        }),
      ),
      strength.level > 0 &&
        createElement(
          'div',
          { className: 'settings-strength', 'data-level': strength.level, 'aria-live': 'polite' },
          createElement(
            'span',
            { className: 'settings-strength-bar', 'aria-hidden': 'true' },
            createElement('i', null),
            createElement('i', null),
            createElement('i', null),
          ),
          createElement('span', null, '密碼強度：', strength.label),
        ),
      createElement(
        Field,
        { label: '確認新密碼', error: errors.confirm },
        createElement(PasswordInput, {
          value: draft.confirm,
          onChange: set('confirm'),
          autoComplete: 'new-password',
          disabled: mutation.isPending,
        }),
      ),
      createElement(
        'div',
        { className: 'settings-actions' },
        createElement(
          Button,
          { type: 'submit', variant: 'primary', disabled: !canSubmit, loading: mutation.isPending },
          '更新密碼',
        ),
      ),
    ),
  );
}

function InfoCard({ profile }) {
  return createElement(
    'section',
    { className: 'settings-card', 'aria-labelledby': 'settings-info-title' },
    createElement(
      'header',
      { className: 'settings-card-head' },
      createElement('h3', { id: 'settings-info-title' }, '帳號資訊'),
      createElement('p', null, '以下資料僅供檢視；角色由管理員調整。'),
    ),
    createElement(
      'dl',
      { className: 'settings-info' },
      createElement(
        'div',
        null,
        createElement('dt', null, '角色'),
        createElement('dd', null, createElement(Badge, { tone: 'accent' }, roleLabel(profile.role))),
      ),
      createElement(
        'div',
        null,
        createElement('dt', null, '建立時間'),
        createElement('dd', null, formatDateTime(profile.createdAt)),
      ),
      profile.lastLoginAt != null &&
        createElement(
          'div',
          null,
          createElement('dt', null, '最近登入'),
          createElement('dd', null, formatDateTime(profile.lastLoginAt)),
        ),
    ),
  );
}

/** 預留的整合項目（ui-refresh §9、requirements U6）：只有說明與停用的開關，不接任何服務 */
const INTEGRATIONS = [
  {
    key: 'ai',
    name: 'AI 助理',
    desc: '用你的任務與討論產生日誌、週報草稿；資料不會離開這台伺服器，除非你在這裡設定外部服務。',
  },
  {
    key: 'notify',
    name: 'Webhook／通知',
    desc: '任務有變動時通知到 Slack、Email 等外部服務。',
  },
];

function IntegrationsCard() {
  return createElement(
    'section',
    { className: 'settings-card settings-card--muted', 'aria-labelledby': 'settings-integrations-title' },
    createElement(
      'header',
      { className: 'settings-card-head' },
      createElement('h3', { id: 'settings-integrations-title' }, '整合 ', createElement(Badge, null, '規劃中')),
      createElement(
        'p',
        null,
        '這裡之後會放 AI 助理（例如幫你把本週任務整理成日誌草稿）與外部通知。目前還沒有接任何服務，開關都是停用的。',
      ),
    ),
    createElement(
      'ul',
      { className: 'settings-int-list' },
      INTEGRATIONS.map((it) =>
        createElement(
          'li',
          { key: it.key, className: 'settings-int-row' },
          createElement(
            'div',
            { className: 'settings-int-main' },
            createElement('span', { className: 'settings-int-name', id: `settings-int-${it.key}` }, it.name),
            createElement('span', { className: 'settings-int-desc' }, it.desc),
          ),
          // 真的 disabled、不接任何事件
          createElement(
            'label',
            { className: 'settings-switch', 'aria-disabled': 'true' },
            createElement('input', {
              type: 'checkbox',
              role: 'switch',
              disabled: true,
              checked: false,
              'aria-labelledby': `settings-int-${it.key}`,
            }),
            createElement('span', { className: 'settings-switch-track', 'aria-hidden': 'true' }),
          ),
        ),
      ),
    ),
    createElement(
      'p',
      { className: 'settings-int-foot' },
      '後端設定點：',
      createElement('code', null, 'integrations'),
      '（見 docs/requirements-2026-11-26.md U6）。',
    ),
  );
}

/** 關於：版本與署名，資料來源是 /api/health（server/app/version.py），不另抄一份 */
function AboutCard() {
  const info = useAppInfo();
  const repo = info?.repository ?? '';
  return createElement(
    'section',
    { className: 'settings-card', 'aria-labelledby': 'settings-about-title' },
    createElement(
      'header',
      { className: 'settings-card-head' },
      createElement('h3', { id: 'settings-about-title' }, '關於'),
    ),
    createElement(
      'dl',
      { className: 'settings-info' },
      createElement(
        'div',
        null,
        createElement('dt', null, '版本'),
        createElement(
          'dd',
          null,
          info?.version ? `${info.app ? `${info.app} ` : ''}v${info.version}` : createElement('span', { className: 'settings-about-dim' }, '—'),
        ),
      ),
      createElement(
        'div',
        null,
        createElement('dt', null, '作者'),
        createElement('dd', null, info?.author || createElement('span', { className: 'settings-about-dim' }, '—')),
      ),
      repo &&
        createElement(
          'div',
          null,
          createElement('dt', null, '原始碼'),
          createElement(
            'dd',
            null,
            createElement(
              'a',
              { className: 'tl-link', href: repo, target: '_blank', rel: 'noopener noreferrer' },
              repo.replace(/^https?:\/\//, ''),
            ),
          ),
        ),
      createElement(
        'div',
        null,
        createElement('dt', null, '更新紀錄'),
        createElement(
          'dd',
          null,
          createElement('code', null, 'CHANGELOG.md'),
          createElement('span', { className: 'settings-about-dim' }, '（原始碼根目錄）'),
        ),
      ),
    ),
  );
}
