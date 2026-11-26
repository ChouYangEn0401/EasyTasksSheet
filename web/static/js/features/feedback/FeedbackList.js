import { createElement, Fragment } from 'preact';
import { useDroppable } from '../../lib/dnd.js';
import { forwardRef, useEffect, useRef, useState } from 'preact/compat';
import { FEEDBACK_KIND_LABELS, FEEDBACK_STATUS_LABELS, FEEDBACK_STATUSES } from '../../shared/feedback.js';
import { errorMessage } from '../../lib/api.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  MultiSelect,
  Select,
  Skeleton,
  Spinner,
} from '../../ui/index.js';
import { LIST_DROP_ID } from './actions.js';
import { useCreateFeedback } from './api.js';
import { FeedbackCard } from './FeedbackCard.js';
import { groupItems, hasFilters } from './model.js';

const KIND_PREF_KEY = 'feedback.lastKind';
const KIND_OPTIONS = ['problem', 'feedback'].map((k) => ({
  value: k,
  label: FEEDBACK_KIND_LABELS[k],
}));

/** 新增列：輸入標題 + 類型，Enter 建立後清空並保持 focus */
const NewItemRow = forwardRef(function NewItemRow(_props, ref) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(() =>
    readStorage(KIND_PREF_KEY) === 'feedback' ? 'feedback' : 'problem',
  );
  const [done, setDone] = useState(false);
  const create = useCreateFeedback();

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);

  const submit = () => {
    const value = title.trim();
    if (!value || create.isPending) return;
    create.mutate(
      { title: value, kind },
      {
        onSuccess: () => {
          setTitle('');
          setDone(true);
        },
      },
    );
  };

  return createElement(
    'div',
    { className: 'fb-new' },
    createElement(
      'div',
      { className: 'fb-new-row' },
      createElement(Input, {
        ref: ref,
        wrapperClassName: 'fb-new-input',
        icon: 'plus',
        'aria-label': '新增問題或回饋',
        placeholder: '新增問題或回饋，按 Enter 建立',
        value: title,
        readOnly: create.isPending,
        invalid: create.isError,
        onChange: (e) => {
          setTitle(e.target.value);
          if (create.isError) create.reset();
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            setTitle('');
            create.reset();
            e.currentTarget.blur();
          }
        },
        end: create.isPending
          ? createElement(Spinner, { size: 14 })
          : done
            ? createElement(Icon, { name: 'check', style: { color: 'var(--color-success)' } })
            : null,
      }),
      createElement(Select, {
        className: 'fb-new-kind',
        'aria-label': '類型',
        options: KIND_OPTIONS,
        value: kind,
        onChange: (k) => {
          setKind(k);
          writeStorage(KIND_PREF_KEY, k);
        },
      }),
    ),
    createElement(
      'div',
      { 'aria-live': 'polite', className: 'fb-new-feedback' },
      create.isError
        ? createElement('span', { className: 'ui-field-error' }, errorMessage(create.error))
        : done
          ? createElement('span', { className: 'fb-new-done' }, '已建立')
          : null,
    ),
  );
});

/** 類型分段切換：全部｜問題｜回饋 */
export function KindSegmented({ value, options, onChange, label }) {
  return createElement(
    'div',
    { className: 'fb-seg', role: 'radiogroup', 'aria-label': label },
    options.map((o) =>
      createElement(
        'button',
        {
          key: o.value,
          type: 'button',
          role: 'radio',
          'aria-checked': o.value === value,
          className: 'fb-seg-item',
          onClick: () => onChange(o.value),
        },
        o.label,
      ),
    ),
  );
}

const STATUS_OPTIONS = FEEDBACK_STATUSES.map((s) => ({ value: s, label: FEEDBACK_STATUS_LABELS[s] }));

function FilterRow({ filters, onChange, onClear }) {
  return createElement(
    'div',
    { className: 'fb-filters' },
    createElement(KindSegmented, {
      label: '類型篩選',
      value: filters.kind ?? 'all',
      options: [{ value: 'all', label: '全部' }, ...KIND_OPTIONS],
      onChange: (v) => onChange({ ...filters, kind: v === 'all' ? null : v }),
    }),
    createElement(MultiSelect, {
      label: '狀態',
      'aria-label': '狀態篩選',
      options: STATUS_OPTIONS,
      value: filters.status,
      onChange: (status) => onChange({ ...filters, status }),
    }),
    hasFilters(filters) && createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClear }, '清除'),
  );
}

function Group({ status, items, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  return createElement(
    'section',
    { className: 'fb-group', 'aria-label': FEEDBACK_STATUS_LABELS[status] },
    createElement(
      'button',
      { type: 'button', className: 'fb-group-head', 'aria-expanded': open, onClick: () => setOpen(!open) },
      createElement(Icon, { name: open ? 'chevronDown' : 'chevronRight' }),
      createElement('span', null, FEEDBACK_STATUS_LABELS[status]),
      createElement(Badge, { count: true }, items.length),
    ),
    open &&
      (items.length
        ? createElement(
            'div',
            { className: 'fb-group-items' },
            items.map((item) => createElement(FeedbackCard, { key: item.id, item: item })),
          )
        : createElement('div', { className: 'fb-group-empty' }, '—')),
  );
}

function ListSkeleton() {
  return createElement(
    'div',
    { className: 'fb-groups', 'aria-busy': 'true', 'aria-label': '載入中' },
    [0, 1, 2].map((g) =>
      createElement(
        'div',
        { key: g, className: 'fb-group' },
        createElement(
          'div',
          { className: 'fb-group-head' },
          createElement(Skeleton, { width: 90, height: 12 }),
        ),
        g < 2 &&
          createElement(
            'div',
            { className: 'fb-group-items' },
            [0, 1, 2].map((i) =>
              createElement(
                'div',
                { key: i, className: 'fb-card fb-card--skeleton' },
                createElement(Skeleton, { width: '80%', height: 12 }),
                createElement(Skeleton, { width: '50%', height: 10 }),
              ),
            ),
          ),
      ),
    ),
  );
}

/** 清單面板：新增列 + 篩選列 + 三個狀態群組；拖曳月曆 chip 時整體成為「取消排程」放置區 */
export const FeedbackList = forwardRef(function FeedbackList(props, inputRef) {
  const { items, total, isLoading, error, onRetry, filters, onFiltersChange, onClearFilters, acceptsDrop } =
    props;
  const data = { type: 'list' };
  // 一律註冊為放置區（拖曳中途才啟用會量不到位置）；清單卡片放回清單時由 onDragEnd 忽略
  const { setNodeRef, isOver } = useDroppable({ id: LIST_DROP_ID, data });
  const groups = groupItems(items);
  const scrollRef = useRef(null);

  let content;
  if (isLoading) content = createElement(ListSkeleton, null);
  else if (error) content = createElement(ErrorState, { error: error, onRetry: onRetry });
  else if (total === 0)
    content = createElement(EmptyState, { title: '還沒有問題或回饋', description: '在上方輸入框新增第一筆' });
  else if (items.length === 0)
    content = createElement(EmptyState, {
      title: '沒有符合條件的項目',
      action: createElement(Button, { variant: 'secondary', onClick: onClearFilters }, '清除篩選'),
    });
  else
    content = createElement(
      'div',
      { className: 'fb-groups' },
      createElement(Group, { status: 'open', items: groups.open, defaultOpen: true }),
      createElement(Group, { status: 'scheduled', items: groups.scheduled, defaultOpen: true }),
      createElement(Group, { status: 'resolved', items: groups.resolved, defaultOpen: false }),
    );

  return createElement(
    'section',
    {
      ref: setNodeRef,
      className: 'fb-panel fb-list-panel',
      'aria-label': '問題與回饋清單',
      'data-drop-active': acceptsDrop || undefined,
      'data-drop-over': (acceptsDrop && isOver) || undefined,
    },
    createElement(
      'div',
      { className: 'fb-list-head' },
      createElement(NewItemRow, { ref: inputRef }),
      createElement(FilterRow, { filters: filters, onChange: onFiltersChange, onClear: onClearFilters }),
    ),
    createElement('div', { ref: scrollRef, className: 'fb-list-scroll' }, content),
    acceptsDrop &&
      createElement('div', { className: 'fb-list-dropzone', 'aria-hidden': 'true' }, '放開以取消排程'),
  );
});
