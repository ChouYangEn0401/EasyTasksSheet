import { useState } from 'react';
import { errorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Alert, Badge, Button, Dialog, EmptyState, Skeleton } from '../../ui/index.ts';
import { usePurgeTrash, useRestoreRecord, useTrash } from './api.ts';

/** 回收區：移到回收區的 worktree 紀錄（可還原；超過保留天數只標示，不會自動清除；清空需 eng.trash.purge） */
export function TrashDialog({ onClose }: { onClose: () => void }) {
  const trash = useTrash(true);
  const restore = useRestoreRecord();
  const purge = usePurgeTrash();
  const canPurge = useCan('eng.trash.purge');
  const byId = useUsersById();
  const [confirming, setConfirming] = useState(false);
  const records = trash.data?.records ?? [];
  const days = trash.data?.retentionDays ?? 30;

  return (
    <Dialog
      open
      size="md"
      title="回收區"
      onClose={onClose}
      actions={
        <>
          {canPurge && records.length > 0 && !confirming && (
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              清空回收區
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <p className="adm-hint">
        移到回收區的 worktree 紀錄會一直保留，{days} 天內建議確認是否還原；超過 {days}
        天也不會自動清除，只有管理者按「清空回收區」才會永久刪除。
      </p>
      {confirming && (
        <Alert tone="danger">
          <div className="eng-pending" role="group" aria-label="確認清空回收區">
            <span>
              將永久刪除回收區中的 {records.length} 筆紀錄，<strong>無法復原</strong>。確定要清空嗎？
            </span>
            <span className="eng-pending-actions">
              <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={purge.isPending}
                onClick={() =>
                  purge.mutate(undefined, {
                    onSuccess: (r) => {
                      notifySuccess(`已永久刪除 ${r.purged} 筆`);
                      setConfirming(false);
                    },
                  })
                }
              >
                永久刪除
              </Button>
            </span>
          </div>
        </Alert>
      )}
      {(restore.error ?? purge.error) != null && (
        <Alert tone="danger">{errorMessage(restore.error ?? purge.error)}</Alert>
      )}
      {!trash.data ? (
        <Skeleton height={80} />
      ) : records.length === 0 ? (
        <EmptyState icon="checkCircle" title="回收區是空的" />
      ) : (
        <ul className="eng-trash-list" aria-label="已刪除的紀錄">
          {records.map((r) => {
            const by = r.deletedBy != null ? byId.get(r.deletedBy)?.displayName : undefined;
            return (
              <li key={r.id} className="eng-trash-item">
                <span className="eng-two-line">
                  <span className="eng-mono">{r.branch || '（無分支）'}</span>
                  <span className="eng-path eng-ellipsis" title={r.path}>
                    {r.machine} · {r.path}
                  </span>
                  <span className="eng-sub">
                    {r.deletedAt != null ? `刪除於 ${formatDateTime(r.deletedAt)}` : ''}
                    {by ? `（${by}）` : ''}
                  </span>
                </span>
                {r.expired && <Badge tone="warning">已超過 {days} 天</Badge>}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={restore.isPending && restore.variables === r.id}
                  onClick={() => restore.mutate(r.id, { onSuccess: () => notifySuccess('已還原') })}
                >
                  還原
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
