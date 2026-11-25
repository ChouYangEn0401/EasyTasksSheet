import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  isLastActiveRoot,
  LAST_ROOT_MESSAGE,
  ROOT_ONLY_MESSAGE,
  type AdminUser,
} from '../../../shared/admin.ts';
import { ApiError } from '../../lib/api.ts';
import { logout, useCurrentUser } from '../../lib/auth.ts';
import { ROLE_BADGE_TONES, useCan } from '../../lib/permissions.ts';
import { FILTER_SEARCH_ATTR } from '../../lib/shortcuts.ts';
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
  type MenuItem,
} from '../../ui/index.ts';
import { CreateUserDialog, DisableUserDialog, EditUserDialog, ResetPasswordDialog } from './AdminDialogs.tsx';
import { useAdminUsers, useUnlockUser, useUpdateAdminUser } from './api.ts';
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
  type AdminFilters,
  type Notify,
  type RowState,
  type StateFilter,
} from './model.ts';
import './admin.css';

type DialogState = { type: 'create' } | { type: 'edit' | 'reset' | 'disable'; id: number } | null;

type Notice = { tone: 'success' | 'danger'; message: string; key: number };

const NOTICE_MS = 4000;

export function NoPermission({ description = '此頁面僅限管理者以上使用' }: { description?: string }) {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon="lock"
      title="沒有權限"
      description={description}
      action={
        <Button variant="primary" onClick={() => navigate('/')}>
          回到總覽
        </Button>
      }
    />
  );
}

/** 成員管理（/admin/users，需 members.manage）。docs/design/admin-users.md、docs/permissions.md */
export function AdminUsersPage() {
  const me = useCurrentUser();
  const allowed = useCan('members.manage');
  const query = useAdminUsers(allowed);
  if (!me) return null;
  if (!allowed || (query.error instanceof ApiError && query.error.status === 403)) return <NoPermission />;
  return <AdminUsersView meId={me.id} query={query} />;
}

function AdminUsersView({ meId, query }: { meId: number; query: ReturnType<typeof useAdminUsers> }) {
  const canAssignRoot = useCan('roles.assign_root');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const setFilters = (f: AdminFilters) => setSearchParams(writeFilters(searchParams, f), { replace: true });
  const clearFilters = () => setFilters({ q: '', state: 'all' });

  const all = useMemo(() => query.data ?? [], [query.data]);
  const visible = useMemo(() => sortUsers(filterUsers(all, filters)), [all, filters]);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const update = useUpdateAdminUser();
  const unlock = useUnlockUser();

  const notify: Notify = (tone, message) =>
    setNotice((prev) => ({ tone, message, key: (prev?.key ?? 0) + 1 }));

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
  const runInline = (u: AdminUser, action: 'unlock' | 'enable') => {
    setPendingId(u.id);
    const common = {
      onSettled: () => setPendingId(null),
      onError: (err: unknown) => notify('danger', failText(err)),
    };
    if (action === 'unlock')
      unlock.mutate(u.id, {
        ...common,
        onSuccess: (r) => notify('success', `已解除「${r.displayName}」的登入鎖定`),
      });
    else
      update.mutate(
        { id: u.id, isActive: true },
        { ...common, onSuccess: (r) => notify('success', `已啟用「${r.displayName}」`) },
      );
  };

  const menuItems = (u: AdminUser): MenuItem[] => {
    // manager 看得到 root，但不能操作（後端同樣 403）
    if (!canManageUser(u, canAssignRoot))
      return [
        { key: 'edit', label: '編輯', disabled: true, onSelect: () => undefined },
        { key: 'why', content: <p className="adm-menu-hint">{ROOT_ONLY_MESSAGE}</p> },
      ];
    const lastAdmin = isLastActiveRoot(u, all);
    const items: MenuItem[] = [
      { key: 'edit', label: '編輯', onSelect: () => setDialog({ type: 'edit', id: u.id }) },
    ];
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
        items.push({ key: 'why', content: <p className="adm-menu-hint">{LAST_ROOT_MESSAGE}</p> });
    } else {
      items.push({ key: 'enable', label: '啟用', onSelect: () => runInline(u, 'enable') });
    }
    return items;
  };

  let body;
  if (query.isPending) body = <SkeletonRows />;
  else if (query.isError && !query.data)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (visible.length === 0)
    body = (
      <EmptyState
        icon="search"
        title="沒有符合條件的成員"
        action={
          hasFilters(filters) && (
            <Button variant="secondary" onClick={clearFilters}>
              清除篩選
            </Button>
          )
        }
      />
    );
  else
    body = (
      <table className="adm-table">
        <thead>
          <tr>
            <th scope="col">成員</th>
            <th scope="col">角色</th>
            <th scope="col">狀態</th>
            <th scope="col" className="adm-col-updated">
              更新
            </th>
            <th scope="col" className="adm-col-actions">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((u) => {
            const state = rowState(u, now);
            return (
              <tr key={u.id} data-state={state} data-username={u.username}>
                <td>
                  <div className="adm-member">
                    <Avatar user={u} size="md" tooltip={false} />
                    <div className="adm-member-text">
                      <div className="adm-name">
                        <span className="adm-name-text">{u.displayName}</span>
                        {u.id === meId && <Badge>你</Badge>}
                      </div>
                      <div className="adm-sub">
                        <span className="adm-username">@{u.username}</span>
                        <span className="adm-inline-updated">
                          <span aria-hidden="true">·</span>
                          <UpdatedAt at={u.updatedAt} />
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge tone={ROLE_BADGE_TONES[u.role]}>{ROLE_LABELS[u.role]}</Badge>
                </td>
                <td>
                  <div className="adm-states">
                    <StateBadge user={u} state={state} now={now} />
                    {u.mustChangePassword && <Badge>待改密碼</Badge>}
                  </div>
                </td>
                <td className="adm-col-updated">
                  <UpdatedAt at={u.updatedAt} />
                </td>
                <td className="adm-col-actions">
                  {pendingId === u.id ? (
                    <span className="adm-row-spinner">
                      <Spinner label="處理中" />
                    </span>
                  ) : (
                    <Menu
                      align="end"
                      width={180}
                      label={`${u.displayName} 的操作`}
                      items={menuItems(u)}
                      trigger={(p) => (
                        <Button
                          {...p}
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon={<MoreIcon />}
                          aria-label={`${u.displayName} 的操作`}
                        />
                      )}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );

  return (
    <div className="adm-page">
      {notice && (
        <Alert key={notice.key} tone={notice.tone} role="status" onClose={() => setNotice(null)}>
          {notice.message}
        </Alert>
      )}
      <div className="adm-toolbar">
        <Input
          icon="search"
          type="search"
          wrapperClassName="adm-search"
          placeholder="搜尋姓名或帳號…"
          aria-label="搜尋姓名或帳號"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          {...{ [FILTER_SEARCH_ATTR]: '' }}
        />
        <Select<StateFilter>
          aria-label="狀態篩選"
          className="adm-state-select"
          value={filters.state}
          onChange={(state) => setFilters({ ...filters, state })}
          options={STATE_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
          renderValue={(o) => <span className="ui-select-label adm-select-label">狀態：{o?.label}</span>}
        />
        <span className="adm-count">{query.data ? `共 ${visible.length} 位` : ''}</span>
        <Button variant="primary" icon="plus" onClick={() => setDialog({ type: 'create' })}>
          新增成員
        </Button>
      </div>
      <div className="adm-card">{body}</div>

      {dialog?.type === 'create' && <CreateUserDialog onClose={closeDialog} />}
      {dialog?.type === 'edit' && target && (
        <EditUserDialog
          user={target}
          all={all}
          meId={meId}
          onClose={closeDialog}
          onSaved={(u, selfDemoted) => {
            closeDialog();
            if (selfDemoted) navigate('/', { replace: true });
            else notify('success', `已更新「${u.displayName}」`);
          }}
        />
      )}
      {dialog?.type === 'reset' && target && (
        <ResetPasswordDialog user={target} onClose={closeDialog} notify={notify} />
      )}
      {dialog?.type === 'disable' && target && (
        <DisableUserDialog
          user={target}
          isSelf={target.id === meId}
          notify={notify}
          onClose={closeDialog}
          onDisabled={(u) => {
            closeDialog();
            if (u.id === meId) void logout();
            else notify('success', `已停用「${u.displayName}」`);
          }}
        />
      )}
    </div>
  );
}

function StateBadge({ user, state, now }: { user: AdminUser; state: RowState; now: number }) {
  if (state === 'disabled')
    return (
      <Badge dot tone="neutral">
        已停用
      </Badge>
    );
  if (state === 'locked')
    return (
      <Tooltip content={lockTooltip(user, now)}>
        <span tabIndex={0} className="adm-focusable">
          <Badge dot tone="warning">
            已鎖定
          </Badge>
        </span>
      </Tooltip>
    );
  return (
    <Badge dot tone="success">
      啟用
    </Badge>
  );
}

/** ⋯（基礎 Icon 無此圖示，以三個圓點繪製；顏色沿用 currentColor） */
function MoreIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

function SkeletonRows() {
  return (
    <div className="adm-skeleton" aria-busy="true" aria-label="載入中">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="adm-skeleton-row">
          <Skeleton width={28} height={28} className="adm-skeleton-avatar" />
          <div className="adm-skeleton-text">
            <Skeleton width={120} height={12} />
            <Skeleton width={72} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}
