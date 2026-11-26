import { createElement, Fragment } from 'preact';
import { useId, useState } from 'preact/compat';
import { Link } from '../../lib/router.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useCan } from '../../lib/permissions.js';
import { Avatar, Badge, Button, ErrorState, Icon, Skeleton, Tooltip } from '../../ui/index.js';
import { useDrawerActive } from '../tasks/drawerActive.js';
import { useTaskHistory } from './api.js';
import { ChangeTable } from './ChangeTable.js';
import { canShowRevert, entryState } from './model.js';
import { RevertDialog } from './RevertDialog.js';

/**
 * 任務詳情最下方可摺疊的「活動歷史」（需 audit.view_task_history）：誰、何時、做了什麼。
 * 有 audit.revert 者可直接還原；固定高度的獨立捲動區，「載入更早」分頁。docs/design/audit-log.md
 */
export function TaskHistorySection({ taskId }) {
  const canView = useCan('audit.view_task_history');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!canView) return null;
  return createElement(
    'section',
    { className: 'task-drawer-section aud-history', 'aria-label': '活動歷史' },
    createElement(
      'button',
      {
        type: 'button',
        className: 'aud-history-toggle',
        'aria-expanded': open,
        'aria-controls': panelId,
        onClick: () => setOpen(!open),
      },
      createElement(Icon, { name: 'chevronRight', className: 'aud-chevron' }),
      createElement('span', null, '活動歷史'),
    ),
    open && createElement('div', { id: panelId }, createElement(HistoryList, { taskId: taskId })),
  );
}

function HistoryList({ taskId }) {
  const query = useTaskHistory(taskId, useDrawerActive());
  const canRevert = useCan('audit.revert');
  const canAudit = useCan('audit.view');
  const [reverting, setReverting] = useState(null);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isPending)
    return createElement(
      'div',
      { className: 'aud-history-loading', 'aria-busy': 'true', 'aria-label': '載入中' },
      createElement(Skeleton, { height: 12, width: '70%' }),
      createElement(Skeleton, { height: 12, width: '55%' }),
    );
  if (query.isError && items.length === 0)
    return createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  if (items.length === 0)
    return createElement('p', { className: 'aud-muted aud-history-empty' }, '還沒有活動紀錄。');

  return createElement(
    Fragment,
    null,
    createElement(
      'ol',
      { className: 'aud-history-list aud-scroll', 'aria-label': '活動歷史', tabIndex: 0 },
      items.map((e) =>
        createElement(HistoryItem, {
          key: e.id,
          entry: e,
          canRevert: canRevert,
          onRevert: () => setReverting(e),
        }),
      ),
      query.hasNextPage &&
        createElement(
          'li',
          { className: 'aud-history-more' },
          createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              loading: query.isFetchingNextPage,
              onClick: () => void query.fetchNextPage(),
            },
            '載入更早',
          ),
        ),
    ),
    canAudit &&
      createElement(
        Link,
        { className: 'aud-link aud-history-all', to: `/admin/audit?taskId=${taskId}` },
        '在稽核紀錄查看',
      ),
    reverting && createElement(RevertDialog, { entry: reverting, onClose: () => setReverting(null) }),
  );
}

function HistoryItem({ entry: e, canRevert, onRevert }) {
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  const state = entryState(e);
  const actor = { id: e.actorId ?? 0, displayName: e.actorName ?? '系統' };
  // 單一短欄位的摘要已足夠清楚；長文字或多欄位才提供「查看差異」
  const hasDetail = e.changes.length > 1 || e.changes.some((c) => c.long);
  return createElement(
    'li',
    { className: 'aud-history-item', 'data-entry-id': e.id },
    createElement(Avatar, { user: actor, size: 'xs', tooltip: false }),
    createElement(
      'div',
      { className: 'aud-history-body' },
      createElement(
        'div',
        { className: 'aud-history-head' },
        createElement('span', { className: 'aud-history-name' }, actor.displayName),
        createElement(
          Tooltip,
          { content: formatDateTime(e.ts) },
          createElement(
            'time',
            { className: 'aud-muted', dateTime: new Date(e.ts).toISOString(), tabIndex: 0 },
            formatRelative(e.ts),
          ),
        ),
        state === 'reverted' && createElement(Badge, { tone: 'neutral' }, '已還原'),
      ),
      createElement('p', { className: 'aud-history-summary' }, e.summary),
      (hasDetail || canShowRevert(e, canRevert)) &&
        createElement(
          'div',
          { className: 'aud-history-actions' },
          hasDetail &&
            createElement(
              'button',
              {
                type: 'button',
                className: 'aud-link',
                'aria-expanded': showDiff,
                'aria-controls': diffId,
                onClick: () => setShowDiff(!showDiff),
              },
              showDiff ? '收合差異' : '查看差異',
            ),
          canShowRevert(e, canRevert) &&
            createElement('button', { type: 'button', className: 'aud-link', onClick: onRevert }, '還原'),
        ),
      showDiff &&
        createElement(
          'div',
          { id: diffId, className: 'aud-history-diff' },
          createElement(ChangeTable, { changes: e.changes, stacked: true }),
        ),
    ),
  );
}
