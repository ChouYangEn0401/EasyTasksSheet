import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/compat';
import { PERSONAL_STATUS_LABEL, PERSONAL_STATUSES } from '../../shared/personal.js';
import { isEditableTarget } from '../../lib/shortcuts.js';
import { Button, Dialog, EmptyState, Input, Select, Skeleton, Textarea, UpdatedAt } from '../../ui/index.js';
import { TodoStatusBadge } from './TodoStatus.js';

function SaveHint({ state, onRetry }) {
  return createElement(
    'span',
    { className: 'pl-save-state', 'aria-live': 'polite' },
    state === 'saving' && '儲存中…',
    state === 'saved' && '已儲存',
    state === 'error' &&
      createElement(
        'span',
        { className: 'pl-save-error' },
        '儲存失敗 ·',
        ' ',
        createElement('button', { type: 'button', className: 'pl-linkbtn', onClick: onRetry }, '重試'),
      ),
  );
}

/**
 * 失焦（或 Ctrl+Enter）儲存的文字欄位：顯示儲存狀態；他人更新（輪詢）在未編輯時同步；
 * 卸載（關閉 inspector / 切換待辦）時送出未存內容。
 */
function TextField({ label, value, multiline, placeholder, readOnly, required, onCommit }) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState('idle');
  const areaRef = useRef(null);
  const latest = useRef({ draft, base });
  const commitRef = useRef(onCommit);
  useEffect(() => {
    latest.current = { draft, base };
    commitRef.current = onCommit;
  });

  if (value !== base && !focused && draft === base && state !== 'saving') {
    setBase(value);
    setDraft(value);
  }

  const save = () => {
    const next = required ? draft.trim() : draft;
    if (required && !next) {
      setDraft(base);
      return;
    }
    if (next === base) return;
    setState('saving');
    onCommit(next, {
      onSuccess: () => {
        setBase(next);
        setDraft((d) => (d === draft ? next : d));
        setState('saved');
      },
      onError: () => setState('error'),
    });
  };

  useEffect(
    () => () => {
      const { draft: d, base: b } = latest.current;
      const next = required ? d.trim() : d;
      if (next !== b && (!required || next)) commitRef.current(next, {});
    },
    [required],
  );

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(multiline && label === '細節' ? 120 : 56, el.scrollHeight)}px`;
  }, [draft, multiline, label]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!multiline && !e.nativeEvent.isComposing))) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return createElement(
    'div',
    { className: 'pl-insp-section' },
    createElement(
      'div',
      { className: 'pl-insp-label' },
      createElement('span', null, label),
      !readOnly && createElement(SaveHint, { state: state, onRetry: save }),
    ),
    readOnly
      ? createElement(
          'p',
          { className: 'pl-insp-readonly' },
          value || createElement('span', { className: 'pl-insp-empty' }, '—'),
        )
      : multiline
        ? createElement(Textarea, {
            ref: areaRef,
            className: 'pl-insp-text',
            value: draft,
            placeholder: placeholder,
            'aria-label': label,
            onFocus: () => setFocused(true),
            onChange: (e) => setDraft(e.target.value),
            onBlur: () => {
              setFocused(false);
              save();
            },
            onKeyDown: onKeyDown,
          })
        : createElement(Input, {
            value: draft,
            placeholder: placeholder,
            'aria-label': label,
            invalid: required && !draft.trim(),
            onFocus: () => setFocused(true),
            onChange: (e) => setDraft(e.target.value),
            onBlur: () => {
              setFocused(false);
              save();
            },
            onKeyDown: onKeyDown,
          }),
  );
}

/**
 * 自由待辦詳情 inspector：由網址 `?todo=<id>` 驅動，右側抽屜（樣式同任務詳情）。
 * 關閉：✕、Esc（編輯中的 Esc 先結束編輯）、移除 ?todo 或瀏覽器上一頁。唯讀（檢視他人清單）時只顯示內容。
 */
export function TodoInspector({ item, loading, readOnly, deleting, onClose, onSave, onDelete }) {
  const titleId = useId();
  const closeRef = useRef(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  let body;
  if (item) {
    body = createElement(InspectorBody, { item: item, titleId: titleId, readOnly: readOnly, onSave: onSave });
  } else if (loading) {
    body = createElement(
      'div',
      { className: 'pl-insp-skeleton', 'aria-busy': 'true', 'aria-label': '載入中' },
      createElement(Skeleton, { height: 24, width: '70%' }),
      createElement(Skeleton, { height: 14, width: '40%' }),
      createElement(Skeleton, { height: 96 }),
    );
  } else {
    body = createElement(EmptyState, {
      title: '找不到這筆待辦',
      description: '它可能已被刪除',
      action: createElement(Button, { variant: 'secondary', onClick: onClose }, '關閉'),
    });
  }

  return createElement(
    Fragment,
    null,
    createElement('div', { className: 'task-drawer-backdrop', onClick: onClose, 'aria-hidden': 'true' }),
    createElement(
      'aside',
      {
        className: 'task-drawer pl-inspector',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': item ? titleId : undefined,
        'aria-label': item ? undefined : '待辦詳情',
        tabIndex: -1,
        style: { outline: 'none' },
      },
      createElement(
        'div',
        { className: 'task-drawer-head' },
        createElement('span', { className: 'task-drawer-id' }, readOnly ? '待辦詳情（唯讀）' : '待辦詳情'),
        createElement(Button, {
          ref: closeRef,
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          'aria-label': '關閉待辦詳情',
          onClick: onClose,
        }),
      ),
      createElement('div', { className: 'task-drawer-body' }, body),
      item &&
        createElement(
          'div',
          { className: 'task-drawer-foot pl-insp-foot' },
          createElement(
            'div',
            { className: 'pl-insp-times' },
            createElement(UpdatedAt, { at: item.createdAt, prefix: '建立於' }),
            createElement(UpdatedAt, { at: item.updatedAt, prefix: '更新於' }),
          ),
          !readOnly &&
            createElement(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                className: 'pl-insp-delete',
                onClick: () => setConfirmDelete(true),
              },
              '刪除待辦',
            ),
        ),
    ),
    createElement(
      Dialog,
      {
        open: confirmDelete && !!item,
        onClose: () => setConfirmDelete(false),
        role: 'alertdialog',
        title: `刪除待辦「${item?.title ?? ''}」？`,
        actions: createElement(
          Fragment,
          null,
          createElement(
            Button,
            { variant: 'secondary', onClick: () => setConfirmDelete(false), 'data-autofocus': true },
            '取消',
          ),
          createElement(
            Button,
            {
              variant: 'danger',
              loading: deleting,
              onClick: () => {
                if (!item) return;
                setConfirmDelete(false);
                onDelete(item);
              },
            },
            '刪除',
          ),
        ),
      },
      createElement('p', { className: 'm-0' }, '刪除後可按 Ctrl+Z 復原。'),
    ),
  );
}

function InspectorBody({ item, titleId, readOnly, onSave }) {
  const statusOptions = PERSONAL_STATUSES.map((s) => ({
    value: s,
    label: PERSONAL_STATUS_LABEL[s],
  }));
  return createElement(
    'div',
    { className: 'pl-insp' },
    createElement('h2', { id: titleId, className: 'sr-only' }, item.title),
    createElement(TextField, {
      label: '標題',
      value: item.title,
      readOnly: readOnly,
      required: true,
      onCommit: (title, cb) => onSave({ title }, cb),
    }),
    createElement(
      'div',
      { className: 'pl-insp-fields' },
      createElement(
        'div',
        { className: 'pl-insp-field' },
        createElement('span', { className: 'pl-insp-label' }, '狀態'),
        readOnly
          ? createElement(TodoStatusBadge, { status: item.status })
          : createElement(Select, {
              'aria-label': '狀態',
              options: statusOptions,
              value: item.status,
              renderValue: () =>
                createElement(
                  'span',
                  { className: 'pl-insp-status-value' },
                  createElement(TodoStatusBadge, { status: item.status }),
                ),
              onChange: (status) => onSave({ status }),
            }),
      ),
      createElement(
        'div',
        { className: 'pl-insp-field' },
        createElement('span', { className: 'pl-insp-label' }, '到期日'),
        readOnly
          ? createElement('span', null, item.dueDate ?? '—')
          : createElement(
              'span',
              { className: 'pl-insp-date' },
              createElement(Input, {
                type: 'date',
                'aria-label': '到期日',
                value: item.dueDate ?? '',
                onChange: (e) => onSave({ dueDate: e.target.value || null }),
              }),
              item.dueDate &&
                createElement(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  iconOnly: true,
                  icon: 'x',
                  'aria-label': '清除到期日',
                  onClick: () => onSave({ dueDate: null }),
                }),
            ),
      ),
    ),
    createElement(TextField, {
      label: '備註',
      value: item.note,
      multiline: true,
      placeholder: '一句話備註（會顯示在列表上）',
      readOnly: readOnly,
      onCommit: (note, cb) => onSave({ note }, cb),
    }),
    createElement(TextField, {
      label: '細節',
      value: item.detail,
      multiline: true,
      placeholder: '記錄細節…（失焦或 Ctrl+Enter 儲存）',
      readOnly: readOnly,
      onCommit: (detail, cb) => onSave({ detail }, cb),
    }),
  );
}
