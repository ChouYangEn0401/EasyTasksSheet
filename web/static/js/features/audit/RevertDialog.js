import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { ApiError, errorMessage } from '../../lib/api.js';
import { notifySuccess, truncate } from '../../lib/toast.js';
import { Alert, Button, Dialog, Skeleton } from '../../ui/index.js';
import { useAuditDetail, useRevert } from './api.js';
import { conflictFromError, revertKindText } from './model.js';

/**
 * 還原確認：顯示將還原的欄位與目前值；這次之後又被改過的欄位以醒目（非紅色）的提示說明，
 * 需按「仍要還原（覆蓋）」才會送出 force。
 */
export function RevertDialog({ entry, onClose }) {
  const detail = useAuditDetail(entry.id);
  const revert = useRevert();
  const [error, setError] = useState(null);
  // 送出時伺服器回報的最新衝突（預覽之後又有人修改）
  const [serverFields, setServerFields] = useState(null);

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
    body = createElement(
      'div',
      { className: 'aud-dialog-loading', 'aria-busy': 'true', 'aria-label': '載入中' },
      createElement(Skeleton, { height: 14, width: '80%' }),
      createElement(Skeleton, { height: 14, width: '60%' }),
    );
  else if (blocked) body = createElement(Alert, { tone: 'info', role: 'status' }, '無法還原：', blocked);
  else
    body = createElement(
      Fragment,
      null,
      detail.isError &&
        createElement(
          'p',
          { className: 'adm-text' },
          '無法載入目前的內容，仍可嘗試還原；若內容在這之後又被修改過，會再提示你確認。',
        ),
      kind !== 'none' &&
        createElement(
          'p',
          { className: 'adm-text' },
          revertKindText(kind, entry.entityLabel ?? '', entry.entityType),
        ),
      fields.length > 0 &&
        createElement(
          'table',
          { className: 'aud-revert-table' },
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement('th', { scope: 'col' }, '欄位'),
              createElement('th', { scope: 'col' }, '目前'),
              createElement('th', { scope: 'col' }, '還原後'),
            ),
          ),
          createElement(
            'tbody',
            null,
            fields.map((f) =>
              createElement(
                'tr',
                { key: f.field, 'data-conflict': f.conflict || undefined },
                createElement('th', { scope: 'row' }, f.label),
                createElement(
                  'td',
                  null,
                  createElement('span', { className: 'aud-clip', title: f.currentText }, f.currentText),
                ),
                createElement(
                  'td',
                  null,
                  createElement('span', { className: 'aud-clip', title: f.beforeText }, f.beforeText),
                ),
              ),
            ),
          ),
        ),
      conflicts.length > 0 &&
        createElement(
          'div',
          { className: 'aud-conflict', role: 'status' },
          createElement(
            'strong',
            null,
            '有 ',
            conflicts.length,
            ' 個欄位在這次修改之後又被改過，還原會覆蓋較新的內容：',
          ),
          createElement(
            'ul',
            null,
            conflicts.map((f) =>
              createElement(
                'li',
                { key: f.field },
                '「',
                f.label,
                '」在此之後又被修改過（現在是「',
                truncate(f.currentText, 30),
                '」，這次修改後是「',
                truncate(f.afterText, 30),
                '」）',
              ),
            ),
          ),
        ),
      error && createElement(Alert, { tone: 'info', onClose: () => setError(null) }, error),
    );

  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      onClose: () => !revert.isPending && onClose(),
      title: '還原這次改動？',
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          { variant: 'secondary', disabled: revert.isPending, onClick: onClose },
          blocked ? '關閉' : '取消',
        ),
        !blocked &&
          createElement(
            Button,
            {
              variant: 'primary',
              loading: revert.isPending,
              disabled: detail.isPending,
              onClick: submit,
              'data-autofocus': true,
            },
            conflicts.length > 0 ? '仍要還原（覆蓋）' : '還原',
          ),
      ),
    },
    createElement('p', { className: 'aud-dialog-summary' }, entry.summary),
    body,
  );
}
