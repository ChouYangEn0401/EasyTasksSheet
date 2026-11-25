import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { AuditEntry } from '../../../shared/audit.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { useCan } from '../../lib/permissions.ts';
import { Avatar, Badge, Button, ErrorState, Icon, Skeleton, Tooltip } from '../../ui/index.ts';
import { useTaskHistory } from './api.ts';
import { ChangeTable } from './ChangeTable.tsx';
import { canShowRevert, entryState } from './model.ts';
import { RevertDialog } from './RevertDialog.tsx';
import './audit.css';

/**
 * 任務詳情最下方可摺疊的「活動歷史」（需 audit.view_task_history）：誰、何時、做了什麼。
 * 有 audit.revert 者可直接還原；固定高度的獨立捲動區，「載入更早」分頁。docs/design/audit-log.md
 */
export function TaskHistorySection({ taskId }: { taskId: number }) {
  const canView = useCan('audit.view_task_history');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!canView) return null;
  return (
    <section className="task-drawer-section aud-history" aria-label="活動歷史">
      <button
        type="button"
        className="aud-history-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronRight" className="aud-chevron" />
        <span>活動歷史</span>
      </button>
      {open && (
        <div id={panelId}>
          <HistoryList taskId={taskId} />
        </div>
      )}
    </section>
  );
}

function HistoryList({ taskId }: { taskId: number }) {
  const query = useTaskHistory(taskId);
  const canRevert = useCan('audit.revert');
  const canAudit = useCan('audit.view');
  const [reverting, setReverting] = useState<AuditEntry | null>(null);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isPending)
    return (
      <div className="aud-history-loading" aria-busy="true" aria-label="載入中">
        <Skeleton height={12} width="70%" />
        <Skeleton height={12} width="55%" />
      </div>
    );
  if (query.isError && items.length === 0)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (items.length === 0) return <p className="aud-muted aud-history-empty">還沒有活動紀錄。</p>;

  return (
    <>
      <ol className="aud-history-list aud-scroll" aria-label="活動歷史" tabIndex={0}>
        {items.map((e) => (
          <HistoryItem key={e.id} entry={e} canRevert={canRevert} onRevert={() => setReverting(e)} />
        ))}
        {query.hasNextPage && (
          <li className="aud-history-more">
            <Button
              variant="ghost"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              載入更早
            </Button>
          </li>
        )}
      </ol>
      {canAudit && (
        <Link className="aud-link aud-history-all" to={`/admin/audit?taskId=${taskId}`}>
          在稽核紀錄查看
        </Link>
      )}
      {reverting && <RevertDialog entry={reverting} onClose={() => setReverting(null)} />}
    </>
  );
}

function HistoryItem({
  entry: e,
  canRevert,
  onRevert,
}: {
  entry: AuditEntry;
  canRevert: boolean;
  onRevert: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  const state = entryState(e);
  const actor = { id: e.actorId ?? 0, displayName: e.actorName ?? '系統' };
  // 單一短欄位的摘要已足夠清楚；長文字或多欄位才提供「查看差異」
  const hasDetail = e.changes.length > 1 || e.changes.some((c) => c.long);
  return (
    <li className="aud-history-item" data-entry-id={e.id}>
      <Avatar user={actor} size="xs" tooltip={false} />
      <div className="aud-history-body">
        <div className="aud-history-head">
          <span className="aud-history-name">{actor.displayName}</span>
          <Tooltip content={formatDateTime(e.ts)}>
            <time className="aud-muted" dateTime={new Date(e.ts).toISOString()} tabIndex={0}>
              {formatRelative(e.ts)}
            </time>
          </Tooltip>
          {state === 'reverted' && <Badge tone="neutral">已還原</Badge>}
        </div>
        <p className="aud-history-summary">{e.summary}</p>
        {(hasDetail || canShowRevert(e, canRevert)) && (
          <div className="aud-history-actions">
            {hasDetail && (
              <button
                type="button"
                className="aud-link"
                aria-expanded={showDiff}
                aria-controls={diffId}
                onClick={() => setShowDiff(!showDiff)}
              >
                {showDiff ? '收合差異' : '查看差異'}
              </button>
            )}
            {canShowRevert(e, canRevert) && (
              <button type="button" className="aud-link" onClick={onRevert}>
                還原
              </button>
            )}
          </div>
        )}
        {showDiff && (
          <div id={diffId} className="aud-history-diff">
            <ChangeTable changes={e.changes} stacked />
          </div>
        )}
      </div>
    </li>
  );
}
