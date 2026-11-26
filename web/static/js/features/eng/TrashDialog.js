import { createElement, Fragment } from 'preact';
import { useMemo, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useUsersById } from '../../lib/hooks.js';
import { useCan } from '../../lib/permissions.js';
import { notifySuccess } from '../../lib/toast.js';
import { Alert, Badge, Button, Dialog, EmptyState, Skeleton } from '../../ui/index.js';
import { usePurgeTrash, useRestoreRecord, useTrash } from './api.js';
import { inView } from './personView.js';

/** 回收區：移到回收區的 worktree 紀錄（可還原；超過保留天數只標示，不會自動清除；清空需 eng.trash.purge） */
export function TrashDialog({ view, onClose }) {
  const trash = useTrash(true);
  const restore = useRestoreRecord();
  const purge = usePurgeTrash();
  const canPurge = useCan('eng.trash.purge');
  const byId = useUsersById();
  const [confirming, setConfirming] = useState(false);
  const records = useMemo(() => inView(trash.data?.records ?? [], view), [trash.data, view]);
  const days = trash.data?.retentionDays ?? 30;

  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      title: '回收區',
      onClose: onClose,
      actions: createElement(
        Fragment,
        null,
        canPurge &&
          records.length > 0 &&
          !confirming &&
          createElement(Button, { variant: 'ghost', onClick: () => setConfirming(true) }, '清空回收區'),
        createElement(Button, { variant: 'primary', onClick: onClose }, '完成'),
      ),
    },
    createElement(
      'p',
      { className: 'adm-hint' },
      '移到回收區的 worktree 紀錄會一直保留，',
      days,
      ' 天內建議確認是否還原；超過 ',
      days,
      '天也不會自動清除，只有管理者按「清空回收區」才會永久刪除。',
    ),
    confirming &&
      createElement(
        Alert,
        { tone: 'danger' },
        createElement(
          'div',
          { className: 'eng-pending', role: 'group', 'aria-label': '確認清空回收區' },
          createElement(
            'span',
            null,
            '將永久刪除回收區中的 ',
            records.length,
            ' 筆紀錄，',
            createElement('strong', null, '無法復原'),
            '。確定要清空嗎？',
          ),
          createElement(
            'span',
            { className: 'eng-pending-actions' },
            createElement(
              Button,
              { size: 'sm', variant: 'secondary', onClick: () => setConfirming(false) },
              '取消',
            ),
            createElement(
              Button,
              {
                size: 'sm',
                variant: 'danger',
                loading: purge.isPending,
                onClick: () =>
                  purge.mutate(undefined, {
                    onSuccess: (r) => {
                      notifySuccess(`已永久刪除 ${r.purged} 筆`);
                      setConfirming(false);
                    },
                  }),
              },
              '永久刪除',
            ),
          ),
        ),
      ),
    (restore.error ?? purge.error) != null &&
      createElement(Alert, { tone: 'danger' }, errorMessage(restore.error ?? purge.error)),
    !trash.data
      ? createElement(Skeleton, { height: 80 })
      : records.length === 0
        ? createElement(EmptyState, { icon: 'checkCircle', title: '回收區是空的' })
        : createElement(
            'ul',
            { className: 'eng-trash-list', 'aria-label': '已刪除的紀錄' },
            records.map((r) => {
              const by = r.deletedBy != null ? byId.get(r.deletedBy)?.displayName : undefined;
              return createElement(
                'li',
                { key: r.id, className: 'eng-trash-item' },
                createElement(
                  'span',
                  { className: 'eng-two-line' },
                  createElement('span', { className: 'eng-mono' }, r.branch || '（無分支）'),
                  createElement(
                    'span',
                    { className: 'eng-path eng-ellipsis', title: r.path },
                    r.machine,
                    ' · ',
                    r.path,
                  ),
                  createElement(
                    'span',
                    { className: 'eng-sub' },
                    r.deletedAt != null ? `刪除於 ${formatDateTime(r.deletedAt)}` : '',
                    by ? `（${by}）` : '',
                  ),
                ),
                r.expired && createElement(Badge, { tone: 'warning' }, '已超過 ', days, ' 天'),
                createElement(
                  Button,
                  {
                    size: 'sm',
                    variant: 'secondary',
                    loading: restore.isPending && restore.variables === r.id,
                    onClick: () =>
                      void restore
                        .mutateAsync(r.id)
                        .then(() => notifySuccess('已還原'))
                        .catch(() => undefined),
                  },
                  '還原',
                ),
              );
            }),
          ),
  );
}
