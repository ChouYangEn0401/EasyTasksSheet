import { useState } from 'react';
import {
  CONFIGURABLE_ROLES,
  type ConfigurableRole,
  type PermissionCapability,
  type PermissionMatrix,
} from '../../../shared/permissions.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
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
} from '../../ui/index.ts';
import { NoPermission } from './AdminUsersPage.tsx';
import { usePermissionMatrix, useResetPermissions, useSavePermissions } from './permissionsApi.ts';
import {
  cellKey,
  cellValue,
  changeSummary,
  groupCapabilities,
  hasOverrides,
  isCustomized,
  pendingChanges,
  toggleCell,
  type Draft,
} from './permissionsModel.ts';
import './admin.css';

const PROTECTED_HINT = '僅限超級管理員，無法授予其他角色';
const ROLE_COLUMNS: { role: ConfigurableRole; label: string }[] = [
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
    return <NoPermission description="此頁面僅限超級管理員使用" />;
  let body;
  if (query.isPending) body = <PermSkeleton />;
  else if (query.isError && !query.data)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else body = <PermissionsView matrix={query.data!} />;
  return <div className="adm-page prm-page">{body}</div>;
}

function PermissionsView({ matrix }: { matrix: PermissionMatrix }) {
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
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

  return (
    <>
      <div className="prm-head">
        <p className="prm-intro">
          <Icon name="info" size={16} />
          <span>權限設定即時生效；超級管理員永遠擁有全部權限。</span>
        </p>
        <Button
          variant="secondary"
          icon="refresh"
          disabled={!hasOverrides(matrix) || busy}
          onClick={() => setConfirmReset(true)}
        >
          還原為預設
        </Button>
      </div>
      {error && (
        <Alert tone="danger" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {groups.map((g) => (
        <section key={g.key} className="adm-card prm-group" aria-labelledby={`prm-g-${g.key}`}>
          <table className="adm-table prm-table">
            <caption id={`prm-g-${g.key}`} className="prm-caption">
              {g.label}
            </caption>
            <thead>
              <tr>
                <th scope="col">權限</th>
                <th scope="col" className="prm-col">
                  超級管理員
                </th>
                {ROLE_COLUMNS.map((c) => (
                  <th key={c.role} scope="col" className="prm-col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.items.map((cap) => (
                <CapabilityRow
                  key={cap.key}
                  cap={cap}
                  draft={draft}
                  disabled={busy}
                  onToggle={(role, v) => setDraft((d) => toggleCell(d, cap, role, v))}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {changes.length > 0 && (
        <div className="prm-bar" role="region" aria-label="未儲存的權限變更">
          <div className="prm-bar-text">
            <strong>{changes.length} 項未儲存變更</strong>
            <span className="prm-bar-summary">{changeSummary(matrix, changes)}</span>
          </div>
          <div className="prm-bar-actions">
            <Button variant="secondary" disabled={save.isPending} onClick={() => setDraft({})}>
              還原未儲存
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={onSave}>
              儲存
            </Button>
          </div>
        </div>
      )}

      {confirmReset && (
        <Dialog
          open
          role="alertdialog"
          onClose={() => !reset.isPending && setConfirmReset(false)}
          title="還原為預設權限？"
          actions={
            <>
              <Button variant="secondary" disabled={reset.isPending} onClick={() => setConfirmReset(false)}>
                取消
              </Button>
              <Button variant="danger" loading={reset.isPending} onClick={onReset}>
                還原
              </Button>
            </>
          }
        >
          <p className="adm-text">
            管理者與成員的所有自訂權限都會移除，改回系統預設；立即對所有在線成員生效。
          </p>
          {changes.length > 0 && <p className="adm-text">尚未儲存的變更也會一併捨棄。</p>}
        </Dialog>
      )}
    </>
  );
}

function CapabilityRow({
  cap,
  draft,
  disabled,
  onToggle,
}: {
  cap: PermissionCapability;
  draft: Draft;
  disabled: boolean;
  onToggle: (role: ConfigurableRole, allowed: boolean) => void;
}) {
  const changed = CONFIGURABLE_ROLES.some((r) => draft[cellKey(r, cap.key)] !== undefined);
  return (
    <tr data-capability={cap.key} data-changed={changed || undefined}>
      <th scope="row" className="prm-cap">
        <div className="prm-cap-name">
          <span>{cap.label}</span>
          {cap.protected && (
            <Tooltip content={PROTECTED_HINT}>
              <span tabIndex={0} className="prm-lock" aria-label={PROTECTED_HINT}>
                <Icon name="lock" size={14} />
              </span>
            </Tooltip>
          )}
          {!cap.protected && isCustomized(draft, cap) && <Badge tone="accent">已自訂</Badge>}
        </div>
        {cap.description && <div className="prm-cap-desc">{cap.description}</div>}
      </th>
      <td className="prm-col">
        <Checkbox checked disabled readOnly aria-label={`超級管理員：${cap.label}（固定擁有）`} />
      </td>
      {ROLE_COLUMNS.map(({ role, label }) => {
        return (
          <td
            key={role}
            className="prm-col"
            data-dirty={draft[cellKey(role, cap.key)] !== undefined || undefined}
          >
            <Checkbox
              checked={cap.protected ? false : cellValue(draft, cap, role)}
              disabled={cap.protected || disabled}
              onChange={(e) => onToggle(role, e.target.checked)}
              aria-label={`${label}：${cap.label}`}
              title={cap.protected ? PROTECTED_HINT : undefined}
            />
          </td>
        );
      })}
    </tr>
  );
}

function PermSkeleton() {
  return (
    <div className="adm-card adm-skeleton" aria-busy="true" aria-label="載入中">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="adm-skeleton-row">
          <div className="adm-skeleton-text">
            <Skeleton width={140} height={12} />
            <Skeleton width={240} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}
