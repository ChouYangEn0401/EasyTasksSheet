import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { FEEDBACK_KIND_LABELS, FEEDBACK_STATUS_LABELS } from '../../shared/feedback.js';
import { errorMessage } from '../../lib/api.js';
import { todayString } from '../../lib/format.js';
import { useUsers, useUsersById } from '../../lib/hooks.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
  UpdatedAt,
} from '../../ui/index.js';
import { useDeleteFeedback, useUpdateFeedback } from './api.js';
import { KindSegmented } from './FeedbackList.js';

const STATUS_TONE = { open: 'neutral', scheduled: 'accent', resolved: 'success' };
const UNASSIGNED = 0;

const toDraft = (item) => ({
  kind: item.kind,
  title: item.title,
  body: item.body,
  assigneeId: item.assigneeId,
  scheduledDate: item.scheduledDate ?? '',
});

/** 只取出有改動的欄位（PATCH 只送改動欄位） */
function diff(item, d) {
  const patch = {};
  if (d.kind !== item.kind) patch.kind = d.kind;
  if (d.title.trim() !== item.title) patch.title = d.title.trim();
  if (d.body !== item.body) patch.body = d.body;
  if (d.assigneeId !== item.assigneeId) patch.assigneeId = d.assigneeId;
  if ((d.scheduledDate || null) !== item.scheduledDate) patch.scheduledDate = d.scheduledDate || null;
  return patch;
}

function EditForm({ item, onClose, onDelete }) {
  const [draft, setDraft] = useState(() => toDraft(item));
  const update = useUpdateFeedback();
  const users = useUsers();
  const usersById = useUsersById();
  const patch = diff(item, draft);
  const dirty = Object.keys(patch).length > 0;
  const titleError = draft.title.trim() ? undefined : '請輸入標題';
  const reporter = item.reporterId != null ? usersById.get(item.reporterId)?.displayName : undefined;
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    if (!dirty || titleError) return;
    update.mutate({ id: item.id, ...patch }, { onSuccess: onClose });
  };

  const assigneeOptions = [
    { value: UNASSIGNED, label: '未指派', leading: createElement(Avatar, { size: 'xs', tooltip: false }) },
    ...(users.data ?? [])
      .filter((u) => u.isActive || u.id === item.assigneeId)
      .map((u) => ({
        value: u.id,
        label: u.displayName,
        leading: createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
      })),
  ];

  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      dirty: dirty,
      onClose: onClose,
      title: item.kind === 'problem' ? '編輯問題' : '編輯回饋',
      actions: createElement(
        Fragment,
        null,
        createElement(
          'div',
          { className: 'fb-dialog-meta' },
          createElement(
            Button,
            { variant: 'ghost', size: 'sm', className: 'fb-danger-text', onClick: onDelete },
            '刪除',
          ),
          createElement(
            'span',
            { className: 'fb-dialog-footer-info' },
            '回報者 ',
            reporter ?? '—',
            ' · ',
            createElement(UpdatedAt, { at: item.updatedAt, by: item.updatedBy, prefix: '更新於' }),
          ),
        ),
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          { variant: 'primary', disabled: !dirty || !!titleError, loading: update.isPending, onClick: save },
          '儲存',
        ),
      ),
    },
    createElement(
      'form',
      {
        className: 'fb-form',
        onSubmit: (e) => {
          e.preventDefault();
          save();
        },
      },
      update.isError && createElement(Alert, { tone: 'danger' }, errorMessage(update.error)),
      createElement(
        'div',
        { className: 'ui-field' },
        createElement('span', { className: 'ui-label' }, '類型'),
        createElement(KindSegmented, {
          label: '類型',
          value: draft.kind,
          options: ['problem', 'feedback'].map((k) => ({
            value: k,
            label: FEEDBACK_KIND_LABELS[k],
          })),
          onChange: (k) => set('kind', k),
        }),
      ),
      createElement(
        Field,
        { label: '標題', error: titleError },
        createElement(Input, {
          value: draft.title,
          onChange: (e) => set('title', e.target.value),
          'data-autofocus': true,
        }),
      ),
      createElement(
        Field,
        { label: '內容' },
        createElement(Textarea, { rows: 6, value: draft.body, onChange: (e) => set('body', e.target.value) }),
      ),
      createElement(
        'div',
        { className: 'fb-form-row' },
        createElement(
          Field,
          { label: '負責人' },
          createElement(Select, {
            options: assigneeOptions,
            value: draft.assigneeId ?? UNASSIGNED,
            onChange: (v) => set('assigneeId', v === UNASSIGNED ? null : v),
          }),
        ),
        createElement(
          Field,
          { label: '排程日' },
          createElement(Input, {
            type: 'date',
            value: draft.scheduledDate,
            onChange: (e) => set('scheduledDate', e.target.value),
            end: draft.scheduledDate
              ? createElement(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  iconOnly: true,
                  icon: 'x',
                  'aria-label': '清除排程日',
                  onClick: () => set('scheduledDate', ''),
                })
              : null,
          }),
        ),
      ),
      createElement(
        'div',
        { className: 'ui-field' },
        createElement('span', { className: 'ui-label' }, '狀態'),
        createElement(
          'span',
          null,
          createElement(Badge, { tone: STATUS_TONE[item.status] }, FEEDBACK_STATUS_LABELS[item.status]),
        ),
      ),
      createElement('button', { type: 'submit', hidden: true }),
    ),
  );
}

function DeleteConfirm({ item, onClose, onDeleted }) {
  const del = useDeleteFeedback();
  const noun = FEEDBACK_KIND_LABELS[item.kind];
  return createElement(
    Dialog,
    {
      open: true,
      role: 'alertdialog',
      onClose: onClose,
      title: `刪除這筆${noun}？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'danger',
            loading: del.isPending,
            'data-autofocus': true,
            onClick: () => del.mutate(item.id, { onSuccess: onDeleted }),
          },
          '刪除',
        ),
      ),
    },
    del.isError && createElement(Alert, { tone: 'danger' }, errorMessage(del.error)),
    createElement('p', { className: 'fb-confirm-text' }, '「', item.title, '」將被刪除，此動作無法復原。'),
  );
}

/** 排入日期…（拖曳的非指標替代路徑） */
function ScheduleForm({ item, onClose, onSubmit }) {
  const [date, setDate] = useState(item.scheduledDate ?? todayString());
  const submit = () => {
    if (!date) return;
    onSubmit(date);
    onClose();
  };
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      title: '排入日期',
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', size: 'sm', onClick: onClose }, '取消'),
        createElement(Button, { variant: 'primary', size: 'sm', disabled: !date, onClick: submit }, '排入'),
      ),
    },
    createElement(
      'form',
      {
        onSubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      createElement(
        Field,
        { label: `「${item.title}」的排程日` },
        createElement(Input, {
          type: 'date',
          value: date,
          onChange: (e) => setDate(e.target.value),
          'data-autofocus': true,
        }),
      ),
    ),
  );
}

/** 依目前 dialog 狀態渲染對應的 Dialog（項目以 id 從最新資料取出，避免顯示過期內容） */
export function FeedbackDialogs({ state, items, onChange, onSchedule }) {
  if (!state) return null;
  const item = items.find((i) => i.id === state.id);
  if (!item) return null;
  const close = () => onChange(null);
  switch (state.type) {
    case 'edit':
      return createElement(EditForm, {
        key: item.id,
        item: item,
        onClose: close,
        onDelete: () => onChange({ type: 'delete', id: item.id, from: 'edit' }),
      });
    case 'delete':
      return createElement(DeleteConfirm, {
        item: item,
        onClose: () => onChange(state.from === 'edit' ? { type: 'edit', id: item.id } : null),
        onDeleted: close,
      });
    case 'schedule':
      return createElement(ScheduleForm, {
        item: item,
        onClose: close,
        onSubmit: (d) => onSchedule(item, d),
      });
  }
}
