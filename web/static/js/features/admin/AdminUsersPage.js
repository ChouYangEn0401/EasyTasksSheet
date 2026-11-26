import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/compat';
import { useNavigate, useSearchParams } from '../../lib/router.js';
import { isLastActiveRoot, LAST_ROOT_MESSAGE, ROOT_ONLY_MESSAGE } from '../../shared/admin.js';
import { ApiError } from '../../lib/api.js';
import { logout, useCurrentUser } from '../../lib/auth.js';
import { ROLE_BADGE_TONES, useCan } from '../../lib/permissions.js';
import { FILTER_SEARCH_ATTR } from '../../lib/shortcuts.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Menu,
  Select,
  Skeleton,
  Spinner,
  Tooltip,
  UpdatedAt,
} from '../../ui/index.js';
import { CreateUserDialog, DisableUserDialog, EditUserDialog, ResetPasswordDialog } from './AdminDialogs.js';
import { useAdminUsers, useUnlockUser, useUpdateAdminUser } from './api.js';
import {
  canManageUser,
  failText,
  filterUsers,
  hasFilters,
  lockTooltip,
  readFilters,
  ROLE_LABELS,
  rowState,
  sortUsers,
  STATE_FILTERS,
  writeFilters,
} from './model.js';

const NOTICE_MS = 4000;

export function NoPermission({ description = '此頁面僅限管理者以上使用' }) {
  const navigate = useNavigate();
  return createElement(EmptyState, {
    icon: 'lock',
    title: '沒有權限',
    description: description,
    action: createElement(Button, { variant: 'primary', onClick: () => navigate('/') }, '回到總覽'),
  });
}

/** 成員管理（/admin/users，需 members.manage）。docs/design/admin-users.md、docs/permissions.md */
export function AdminUsersPage() {
  const me = useCurrentUser();
  const allowed = useCan('members.manage');
  const query = useAdminUsers(allowed);
  if (!me) return null;
  if (!allowed || (query.error instanceof ApiError && query.error.status === 403))
    return createElement(NoPermission, null);
  return createElement(AdminUsersView, { meId: me.id, query: query });
}

function AdminUsersView({ meId, query }) {
  const canAssignRoot = useCan('roles.assign_root');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const setFilters = (f) => setSearchParams(writeFilters(searchParams, f), { replace: true });
  const clearFilters = () => setFilters({ q: '', state: 'all' });

  const all = useMemo(() => query.data ?? [], [query.data]);
  const visible = useMemo(() => sortUsers(filterUsers(all, filters)), [all, filters]);

  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const update = useUpdateAdminUser();
  const unlock = useUnlockUser();

  const notify = (tone, message) => setNotice((prev) => ({ tone, message, key: (prev?.key ?? 0) + 1 }));

  // 成功提示 4 秒後自動收起；失敗提示保留到手動關閉
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 每 30 秒重算鎖定剩餘時間
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const now = Math.max(tick, query.dataUpdatedAt);

  const closeDialog = () => setDialog(null);
  const target = dialog && dialog.type !== 'create' ? all.find((u) => u.id === dialog.id) : undefined;

  /** 立即執行的動作（解除鎖定、啟用）：該列 ⋯ 換為 Spinner */
  const runInline = (u, action) => {
    setPendingId(u.id);
    // mutateAsync：快速對多位成員操作時，每一筆的結果都會提示（mutate 的呼叫層回呼只保留最後一次）
    const run =
      action === 'unlock'
        ? unlock.mutateAsync(u.id).then((r) => notify('success', `已解除「${r.displayName}」的登入鎖定`))
        : update
            .mutateAsync({ id: u.id, isActive: true })
            .then((r) => notify('success', `已啟用「${r.displayName}」`));
    void run
      .catch((err) => notify('danger', failText(err)))
      .finally(() => setPendingId((id) => (id === u.id ? null : id)));
  };

  const menuItems = (u) => {
    // manager 看得到 root，但不能操作（後端同樣 403）
    if (!canManageUser(u, canAssignRoot))
      return [
        { key: 'edit', label: '編輯', disabled: true, onSelect: () => undefined },
        { key: 'why', content: createElement('p', { className: 'adm-menu-hint' }, ROOT_ONLY_MESSAGE) },
      ];
    const lastAdmin = isLastActiveRoot(u, all);
    const items = [{ key: 'edit', label: '編輯', onSelect: () => setDialog({ type: 'edit', id: u.id }) }];
    if (u.isActive)
      items.push({ key: 'reset', label: '重設密碼', onSelect: () => setDialog({ type: 'reset', id: u.id }) });
    if (rowState(u, now) === 'locked')
      items.push({ key: 'unlock', label: '解除鎖定', onSelect: () => runInline(u, 'unlock') });
    if (u.isActive) {
      items.push({ key: 'sep', separator: true });
      items.push({
        key: 'disable',
        label: '停用',
        danger: true,
        disabled: lastAdmin,
        onSelect: () => setDialog({ type: 'disable', id: u.id }),
      });
      if (lastAdmin)
        items.push({
          key: 'why',
          content: createElement('p', { className: 'adm-menu-hint' }, LAST_ROOT_MESSAGE),
        });
    } else {
      items.push({ key: 'enable', label: '啟用', onSelect: () => runInline(u, 'enable') });
    }
    return items;
  };

  let body;
  if (query.isPending) body = createElement(SkeletonRows, null);
  else if (query.isError && !query.data)
    body = createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  else if (visible.length === 0)
    body = createElement(EmptyState, {
      icon: 'search',
      title: '沒有符合條件的成員',
      action:
        hasFilters(filters) &&
        createElement(Button, { variant: 'secondary', onClick: clearFilters }, '清除篩選'),
    });
  else
    body = createElement(
      'table',
      { className: 'adm-table' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col' }, '成員'),
          createElement('th', { scope: 'col' }, '角色'),
          createElement('th', { scope: 'col' }, '狀態'),
          createElement('th', { scope: 'col', className: 'adm-col-updated' }, '更新'),
          createElement(
            'th',
            { scope: 'col', className: 'adm-col-actions' },
            createElement('span', { className: 'sr-only' }, '操作'),
          ),
        ),
      ),
      createElement(
        'tbody',
        null,
        visible.map((u) => {
          const state = rowState(u, now);
          return createElement(
            'tr',
            { key: u.id, 'data-state': state, 'data-username': u.username },
            createElement(
              'td',
              null,
              createElement(
                'div',
                { className: 'adm-member' },
                createElement(Avatar, { user: u, size: 'md', tooltip: false }),
                createElement(
                  'div',
                  { className: 'adm-member-text' },
                  createElement(
                    'div',
                    { className: 'adm-name' },
                    createElement('span', { className: 'adm-name-text' }, u.displayName),
                    u.id === meId && createElement(Badge, null, '你'),
                  ),
                  createElement(
                    'div',
                    { className: 'adm-sub' },
                    createElement('span', { className: 'adm-username' }, '@', u.username),
                    createElement(
                      'span',
                      { className: 'adm-inline-updated' },
                      createElement('span', { 'aria-hidden': 'true' }, '·'),
                      createElement(UpdatedAt, { at: u.updatedAt }),
                    ),
                  ),
                ),
              ),
            ),
            createElement(
              'td',
              null,
              createElement(Badge, { tone: ROLE_BADGE_TONES[u.role] }, ROLE_LABELS[u.role]),
            ),
            createElement(
              'td',
              null,
              createElement(
                'div',
                { className: 'adm-states' },
                createElement(StateBadge, { user: u, state: state, now: now }),
                u.mustChangePassword && createElement(Badge, null, '待改密碼'),
                !u.inOverview &&
                  createElement(
                    Tooltip,
                    { content: '不列入總覽統計。任務仍可指派給他。' },
                    createElement(
                      'span',
                      { tabIndex: 0, className: 'adm-focusable' },
                      createElement(Badge, null, '不列入總覽'),
                    ),
                  ),
              ),
            ),
            createElement(
              'td',
              { className: 'adm-col-updated' },
              createElement(UpdatedAt, { at: u.updatedAt }),
            ),
            createElement(
              'td',
              { className: 'adm-col-actions' },
              pendingId === u.id
                ? createElement(
                    'span',
                    { className: 'adm-row-spinner' },
                    createElement(Spinner, { label: '處理中' }),
                  )
                : createElement(Menu, {
                    align: 'end',
                    width: 180,
                    label: `${u.displayName} 的操作`,
                    items: menuItems(u),
                    trigger: (p) =>
                      createElement(Button, {
                        ...p,
                        variant: 'ghost',
                        size: 'sm',
                        iconOnly: true,
                        icon: createElement(MoreIcon, null),
                        'aria-label': `${u.displayName} 的操作`,
                      }),
                  }),
            ),
          );
        }),
      ),
    );

  return createElement(
    'div',
    { className: 'adm-page' },
    notice &&
      createElement(
        Alert,
        { key: notice.key, tone: notice.tone, role: 'status', onClose: () => setNotice(null) },
        notice.message,
      ),
    createElement(
      'div',
      { className: 'adm-toolbar' },
      createElement(Input, {
        icon: 'search',
        type: 'search',
        wrapperClassName: 'adm-search',
        placeholder: '搜尋姓名或帳號…',
        'aria-label': '搜尋姓名或帳號',
        value: filters.q,
        onChange: (e) => setFilters({ ...filters, q: e.target.value }),
        [FILTER_SEARCH_ATTR]: '',
      }),
      createElement(Select, {
        'aria-label': '狀態篩選',
        className: 'adm-state-select',
        value: filters.state,
        onChange: (state) => setFilters({ ...filters, state }),
        options: STATE_FILTERS.map((s) => ({ value: s.value, label: s.label })),
        renderValue: (o) =>
          createElement('span', { className: 'ui-select-label adm-select-label' }, '狀態：', o?.label),
      }),
      createElement('span', { className: 'adm-count' }, query.data ? `共 ${visible.length} 位` : ''),
      createElement(
        Button,
        { variant: 'primary', icon: 'plus', onClick: () => setDialog({ type: 'create' }) },
        '新增成員',
      ),
    ),
    createElement('div', { className: 'adm-card' }, body),

    dialog?.type === 'create' && createElement(CreateUserDialog, { onClose: closeDialog }),
    dialog?.type === 'edit' &&
      target &&
      createElement(EditUserDialog, {
        user: target,
        all: all,
        meId: meId,
        onClose: closeDialog,
        onSaved: (u, selfDemoted) => {
          closeDialog();
          if (selfDemoted) navigate('/', { replace: true });
          else notify('success', `已更新「${u.displayName}」`);
        },
      }),
    dialog?.type === 'reset' &&
      target &&
      createElement(ResetPasswordDialog, { user: target, onClose: closeDialog, notify: notify }),
    dialog?.type === 'disable' &&
      target &&
      createElement(DisableUserDialog, {
        user: target,
        isSelf: target.id === meId,
        notify: notify,
        onClose: closeDialog,
        onDisabled: (u) => {
          closeDialog();
          if (u.id === meId) void logout();
          else notify('success', `已停用「${u.displayName}」`);
        },
      }),
  );
}

function StateBadge({ user, state, now }) {
  if (state === 'disabled') return createElement(Badge, { dot: true, tone: 'neutral' }, '已停用');
  if (state === 'locked')
    return createElement(
      Tooltip,
      { content: lockTooltip(user, now) },
      createElement(
        'span',
        { tabIndex: 0, className: 'adm-focusable' },
        createElement(Badge, { dot: true, tone: 'warning' }, '已鎖定'),
      ),
    );
  return createElement(Badge, { dot: true, tone: 'success' }, '啟用');
}

/** ⋯（基礎 Icon 無此圖示，以三個圓點繪製；顏色沿用 currentColor） */
function MoreIcon() {
  return createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'currentColor' },
    createElement('circle', { cx: '3.5', cy: '8', r: '1.25' }),
    createElement('circle', { cx: '8', cy: '8', r: '1.25' }),
    createElement('circle', { cx: '12.5', cy: '8', r: '1.25' }),
  );
}

function SkeletonRows() {
  return createElement(
    'div',
    { className: 'adm-skeleton', 'aria-busy': 'true', 'aria-label': '載入中' },
    Array.from({ length: 5 }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'adm-skeleton-row' },
        createElement(Skeleton, { width: 28, height: 28, className: 'adm-skeleton-avatar' }),
        createElement(
          'div',
          { className: 'adm-skeleton-text' },
          createElement(Skeleton, { width: 120, height: 12 }),
          createElement(Skeleton, { width: 72, height: 10 }),
        ),
      ),
    ),
  );
}
