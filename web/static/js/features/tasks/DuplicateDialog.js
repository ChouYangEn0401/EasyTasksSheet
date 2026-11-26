import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { useStatuses } from '../../lib/hooks.js';
import { notifySuccess, quoteName } from '../../lib/toast.js';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '../../ui/index.js';
import { openDuplicated } from './drawerNav.js';
import { useDuplicateTask } from './relationData.js';
import { allCopyOptions, COPY_OPTIONS, defaultCopyTitle, defaultDuplicateStatus } from './relationModel.js';

/** 複製任務對話框（TaskDrawer「⋯」選單或在抽屜內按 D 開啟） */
export function DuplicateDialog({ task, open, onClose }) {
  return createElement(
    Dialog,
    { open: open, onClose: onClose, title: '複製任務', size: 'md' },
    open && createElement(DuplicateForm, { task: task, onClose: onClose }),
  );
}

function DuplicateForm({ task, onClose }) {
  const statuses = useStatuses().data;
  const dup = useDuplicateTask(task.id);
  const [title, setTitle] = useState(() => defaultCopyTitle(task.title));
  const [copy, setCopy] = useState(allCopyOptions);
  const [statusId, setStatusId] = useState(null);
  const [relate, setRelate] = useState(true);
  const effectiveStatus = statusId ?? defaultDuplicateStatus(statuses);
  const trimmed = title.trim();
  const titleError = trimmed ? null : '請輸入標題';

  const submit = (e) => {
    e?.preventDefault();
    if (titleError || dup.isPending) return;
    dup.mutate(
      { title: trimmed, copy, relate, ...(effectiveStatus != null ? { statusId: effectiveStatus } : {}) },
      {
        onSuccess: (created) => {
          onClose();
          notifySuccess(`已建立${quoteName(created.title)}`);
          openDuplicated(created.id);
        },
      },
    );
  };

  return createElement(
    'form',
    {
      className: 'tr-dup',
      onSubmit: submit,
      onKeyDown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      },
    },
    createElement(
      Field,
      { label: '標題', error: titleError },
      createElement(Input, {
        value: title,
        maxLength: 500,
        onChange: (e) => setTitle(e.target.value),
        'data-autofocus': true,
        onFocus: (e) => e.currentTarget.select(),
      }),
    ),
    createElement(
      'fieldset',
      { className: 'tr-dup-fieldset' },
      createElement('legend', { className: 'tr-dup-legend' }, '複製內容'),
      createElement(
        'div',
        { className: 'tr-dup-grid' },
        COPY_OPTIONS.map((o) =>
          createElement(Checkbox, {
            key: o.key,
            label: o.label,
            checked: copy[o.key],
            onChange: (e) => setCopy((c) => ({ ...c, [o.key]: e.target.checked })),
          }),
        ),
      ),
      createElement(
        'p',
        { className: 'tr-dup-hint' },
        '專案一律沿用；進度歸零，不複製完成時間、附件、釘選與既有關聯。',
      ),
    ),
    createElement(
      Field,
      { label: '狀態' },
      createElement(Select, {
        'aria-label': '狀態',
        options: (statuses ?? []).map((s) => ({
          value: s.id,
          label: s.name,
          leading: createElement('span', {
            className: 'tr-dot',
            style: statusStyle(statusTone(s)),
            'aria-hidden': 'true',
          }),
        })),
        value: effectiveStatus,
        onChange: (v) => setStatusId(v),
        placeholder: '載入中…',
      }),
    ),
    createElement(Checkbox, {
      label: '並與原任務建立相關連結',
      checked: relate,
      onChange: (e) => setRelate(e.target.checked),
    }),
    dup.isError && createElement(Alert, { tone: 'danger' }, errorMessage(dup.error)),
    createElement(
      'div',
      { className: 'tr-dup-actions' },
      createElement('span', { className: 'tr-dup-kbd' }, 'Ctrl + Enter 建立'),
      createElement(Button, { type: 'button', variant: 'secondary', onClick: onClose }, '取消'),
      createElement(
        Button,
        { type: 'submit', variant: 'primary', loading: dup.isPending, disabled: !!titleError },
        '建立',
      ),
    ),
  );
}
