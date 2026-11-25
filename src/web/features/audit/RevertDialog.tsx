import { useState } from 'react';
import type { AuditEntry, RevertField } from '../../../shared/audit.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { notifySuccess, truncate } from '../../lib/toast.ts';
import { Alert, Button, Dialog, Skeleton } from '../../ui/index.ts';
import { useAuditDetail, useRevert } from './api.ts';
import { conflictFromError, revertKindText } from './model.ts';
import './audit.css';

type Target = Pick<AuditEntry, 'id' | 'summary' | 'entityType' | 'entityLabel'>;

/**
 * 還原確認：顯示將還原的欄位與目前值；這次之後又被改過的欄位以醒目（非紅色）的提示說明，
 * 需按「仍要還原（覆蓋）」才會送出 force。
 */
export function RevertDialog({ entry, onClose }: { entry: Target; onClose: () => void }) {
  const detail = useAuditDetail(entry.id);
  const revert = useRevert();
  const [error, setError] = useState<string | null>(null);
  // 送出時伺服器回報的最新衝突（預覽之後又有人修改）
  const [serverFields, setServerFields] = useState<RevertField[] | null>(null);

  const preview = detail.data?.revertPreview;
  const fields = serverFields ?? preview?.fields ?? [];
  const conflicts = fields.filter((f) => f.conflict);
  const blocked = preview?.blocked ?? null;
  const kind = preview?.kind ?? 'none';

  const submit = () => {
    setError(null);
    revert.mutate(
      { id: entry.id, force: conflicts.length > 0 },
      {
        onSuccess: () => {
          notifySuccess(`已還原：${truncate(entry.summary, 40)}`);
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'REVERT_CONFLICT') {
            const f = conflictFromError(err.details);
            if (f) {
              setServerFields(f);
              return;
            }
          }
          setError(errorMessage(err));
        },
      },
    );
  };

  let body;
  if (detail.isPending)
    body = (
      <div className="aud-dialog-loading" aria-busy="true" aria-label="載入中">
        <Skeleton height={14} width="80%" />
        <Skeleton height={14} width="60%" />
      </div>
    );
  else if (blocked)
    body = (
      <Alert tone="info" role="status">
        無法還原：{blocked}
      </Alert>
    );
  else
    body = (
      <>
        {detail.isError && (
          <p className="adm-text">
            無法載入目前的內容，仍可嘗試還原；若內容在這之後又被修改過，會再提示你確認。
          </p>
        )}
        {kind !== 'none' && (
          <p className="adm-text">{revertKindText(kind, entry.entityLabel ?? '', entry.entityType)}</p>
        )}
        {fields.length > 0 && (
          <table className="aud-revert-table">
            <thead>
              <tr>
                <th scope="col">欄位</th>
                <th scope="col">目前</th>
                <th scope="col">還原後</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.field} data-conflict={f.conflict || undefined}>
                  <th scope="row">{f.label}</th>
                  <td>
                    <span className="aud-clip" title={f.currentText}>
                      {f.currentText}
                    </span>
                  </td>
                  <td>
                    <span className="aud-clip" title={f.beforeText}>
                      {f.beforeText}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {conflicts.length > 0 && (
          <div className="aud-conflict" role="status">
            <strong>有 {conflicts.length} 個欄位在這次修改之後又被改過，還原會覆蓋較新的內容：</strong>
            <ul>
              {conflicts.map((f) => (
                <li key={f.field}>
                  「{f.label}」在此之後又被修改過（現在是「{truncate(f.currentText, 30)}」，這次修改後是「
                  {truncate(f.afterText, 30)}」）
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <Alert tone="info" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
      </>
    );

  return (
    <Dialog
      open
      size="md"
      onClose={() => !revert.isPending && onClose()}
      title="還原這次改動？"
      actions={
        <>
          <Button variant="secondary" disabled={revert.isPending} onClick={onClose}>
            {blocked ? '關閉' : '取消'}
          </Button>
          {!blocked && (
            <Button
              variant="primary"
              loading={revert.isPending}
              disabled={detail.isPending}
              onClick={submit}
              data-autofocus
            >
              {conflicts.length > 0 ? '仍要還原（覆蓋）' : '還原'}
            </Button>
          )}
        </>
      }
    >
      <p className="aud-dialog-summary">{entry.summary}</p>
      {body}
    </Dialog>
  );
}
