import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { CONFIGURABLE_ROLES } from '../../shared/permissions.js';
import { ApiError, errorMessage } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useCan } from '../../lib/permissions.js';
import { notifySuccess } from '../../lib/toast.js';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  Icon,
  Skeleton,
  Tooltip,
} from '../../ui/index.js';
import { NoPermission } from './AdminUsersPage.js';
import { usePermissionMatrix, useResetPermissions, useSavePermissions } from './permissionsApi.js';
import {
  cellKey,
  cellValue,
  changeSummary,
  groupCapabilities,
  hasOverrides,
  isCustomized,
  pendingChanges,
  toggleCell,
} from './permissionsModel.js';

const PROTECTED_HINT = '僅限超級管理員，無法授予其他角色';
const ROLE_COLUMNS = [
  { role: 'manager', label: '管理者' },
  { role: 'user', label: '成員' },
];

/** 權限設定（/admin/permissions，需 permissions.configure）。docs/design/permissions-config.md */
export function PermissionsPage() {
  const me = useCurrentUser();
  const allowed = useCan('permissions.configure');
  const query = usePermissionMatrix(allowed);
  if (!me) return null;
  if (!allowed || (query.error instanceof ApiError && query.error.status === 403))
    return createElement(NoPermission, { description: '此頁面僅限超級管理員使用' });
  let body;
  if (query.isPending) body = createElement(PermSkeleton, null);
  else if (query.isError && !query.data)
    body = createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  else body = createElement(PermissionsView, { matrix: query.data });
  return createElement('div', { className: 'adm-page prm-page' }, body);
}

function PermissionsView({ matrix }) {
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const save = useSavePermissions();
  const reset = useResetPermissions();

  const changes = pendingChanges(matrix, draft);
  const groups = groupCapabilities(matrix);
  const busy = save.isPending || reset.isPending;

  const onSave = () => {
    setError(null);
    save.mutate(changes, {
      onSuccess: () => {
        setDraft({});
        notifySuccess('已儲存權限設定');
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const onReset = () => {
    setError(null);
    reset.mutate(undefined, {
      onSuccess: () => {
        setDraft({});
        setConfirmReset(false);
        notifySuccess('已還原為預設權限');
      },
      onError: (err) => {
        setConfirmReset(false);
        setError(errorMessage(err));
      },
    });
  };

  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'prm-head' },
      createElement(
        'p',
        { className: 'prm-intro' },
        createElement(Icon, { name: 'info', size: 16 }),
        createElement('span', null, '權限設定即時生效；超級管理員永遠擁有全部權限。'),
      ),
      createElement(
        Button,
        {
          variant: 'secondary',
          icon: 'refresh',
          disabled: !hasOverrides(matrix) || busy,
          onClick: () => setConfirmReset(true),
        },
        '還原為預設',
      ),
    ),
    error && createElement(Alert, { tone: 'danger', onClose: () => setError(null) }, error),
    groups.map((g) =>
      createElement(
        'section',
        { key: g.key, className: 'adm-card prm-group', 'aria-labelledby': `prm-g-${g.key}` },
        createElement(
          'table',
          { className: 'adm-table prm-table' },
          createElement('caption', { id: `prm-g-${g.key}`, className: 'prm-caption' }, g.label),
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement('th', { scope: 'col' }, '權限'),
              createElement('th', { scope: 'col', className: 'prm-col' }, '超級管理員'),
              ROLE_COLUMNS.map((c) =>
                createElement('th', { key: c.role, scope: 'col', className: 'prm-col' }, c.label),
              ),
            ),
          ),
          createElement(
            'tbody',
            null,
            g.items.map((cap) =>
              createElement(CapabilityRow, {
                key: cap.key,
                cap: cap,
                draft: draft,
                disabled: busy,
                onToggle: (role, v) => setDraft((d) => toggleCell(d, cap, role, v)),
              }),
            ),
          ),
        ),
      ),
    ),
    changes.length > 0 &&
      createElement(
        'div',
        { className: 'prm-bar', role: 'region', 'aria-label': '未儲存的權限變更' },
        createElement(
          'div',
          { className: 'prm-bar-text' },
          createElement('strong', null, changes.length, ' 項未儲存變更'),
          createElement('span', { className: 'prm-bar-summary' }, changeSummary(matrix, changes)),
        ),
        createElement(
          'div',
          { className: 'prm-bar-actions' },
          createElement(
            Button,
            { variant: 'secondary', disabled: save.isPending, onClick: () => setDraft({}) },
            '還原未儲存',
          ),
          createElement(Button, { variant: 'primary', loading: save.isPending, onClick: onSave }, '儲存'),
        ),
      ),
    confirmReset &&
      createElement(
        Dialog,
        {
          open: true,
          role: 'alertdialog',
          onClose: () => !reset.isPending && setConfirmReset(false),
          title: '還原為預設權限？',
          actions: createElement(
            Fragment,
            null,
            createElement(
              Button,
              { variant: 'secondary', disabled: reset.isPending, onClick: () => setConfirmReset(false) },
              '取消',
            ),
            createElement(Button, { variant: 'danger', loading: reset.isPending, onClick: onReset }, '還原'),
          ),
        },
        createElement(
          'p',
          { className: 'adm-text' },
          '管理者與成員的所有自訂權限都會移除，改回系統預設；立即對所有在線成員生效。',
        ),
        changes.length > 0 && createElement('p', { className: 'adm-text' }, '尚未儲存的變更也會一併捨棄。'),
      ),
  );
}

function CapabilityRow({ cap, draft, disabled, onToggle }) {
  const changed = CONFIGURABLE_ROLES.some((r) => draft[cellKey(r, cap.key)] !== undefined);
  return createElement(
    'tr',
    { 'data-capability': cap.key, 'data-changed': changed || undefined },
    createElement(
      'th',
      { scope: 'row', className: 'prm-cap' },
      createElement(
        'div',
        { className: 'prm-cap-name' },
        createElement('span', null, cap.label),
        cap.protected &&
          createElement(
            Tooltip,
            { content: PROTECTED_HINT },
            createElement(
              'span',
              { tabIndex: 0, className: 'prm-lock', 'aria-label': PROTECTED_HINT },
              createElement(Icon, { name: 'lock', size: 14 }),
            ),
          ),
        !cap.protected && isCustomized(draft, cap) && createElement(Badge, { tone: 'accent' }, '已自訂'),
      ),
      cap.description && createElement('div', { className: 'prm-cap-desc' }, cap.description),
    ),
    createElement(
      'td',
      { className: 'prm-col' },
      createElement(Checkbox, {
        checked: true,
        disabled: true,
        readOnly: true,
        'aria-label': `超級管理員：${cap.label}（固定擁有）`,
      }),
    ),
    ROLE_COLUMNS.map(({ role, label }) => {
      return createElement(
        'td',
        {
          key: role,
          className: 'prm-col',
          'data-dirty': draft[cellKey(role, cap.key)] !== undefined || undefined,
        },
        createElement(Checkbox, {
          checked: cap.protected ? false : cellValue(draft, cap, role),
          disabled: cap.protected || disabled,
          onChange: (e) => onToggle(role, e.target.checked),
          'aria-label': `${label}：${cap.label}`,
          title: cap.protected ? PROTECTED_HINT : undefined,
        }),
      );
    }),
  );
}

function PermSkeleton() {
  return createElement(
    'div',
    { className: 'adm-card adm-skeleton', 'aria-busy': 'true', 'aria-label': '載入中' },
    Array.from({ length: 6 }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'adm-skeleton-row' },
        createElement(
          'div',
          { className: 'adm-skeleton-text' },
          createElement(Skeleton, { width: 140, height: 12 }),
          createElement(Skeleton, { width: 240, height: 10 }),
        ),
      ),
    ),
  );
}
