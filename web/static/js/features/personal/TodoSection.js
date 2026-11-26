import { createElement, Fragment } from 'preact';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '../../lib/dnd.js';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '../../lib/dnd.js';
import { CSS } from '../../lib/dnd.js';
import { useEffect, useRef, useState } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { sortOrderForMove } from '../../shared/personal.js';
import { isEditableTarget, shortcutsSuspended, suspendGlobalShortcuts } from '../../lib/shortcuts.js';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Spinner,
  UpdatedAt,
} from '../../ui/index.js';
import { useClearDoneTodos, useCreateTodo, useDeleteTodo, useTodos, useUpdateTodo } from './api.js';
import { GripIcon } from './icons.js';
import {
  announce,
  dueLabel,
  filterCounts,
  filterTodos,
  groupTodos,
  readTodoParam,
  STATUS_FILTERS,
} from './model.js';
import { SectionCard, SkeletonRows } from './TaskSections.js';
import { TodoInspector } from './TodoInspector.js';
import { StatusChip } from './TodoStatus.js';

const SAVE_FAILED = '儲存失敗，請再試一次';
const ROW_SELECTOR = '[data-todo-id]';

/* ── 新增列 ─────────────────────── */

function AddTodo({ inputRef }) {
  const [value, setValue] = useState('');
  const create = useCreateTodo();
  const [error, setError] = useState(null);

  const submit = () => {
    const title = value.trim();
    if (!title || create.isPending) return;
    setError(null);
    create.mutate(
      { title },
      {
        onSuccess: () => setValue(''),
        onError: () => setError('新增失敗，請再試一次'),
      },
    );
  };

  return createElement(
    'div',
    { className: 'pl-add' },
    createElement(Input, {
      ref: inputRef,
      icon: 'plus',
      value: value,
      placeholder: '新增待辦，按 Enter 建立',
      'aria-label': '新增待辦',
      readOnly: create.isPending,
      invalid: !!error,
      end: create.isPending ? createElement(Spinner, { size: 14 }) : null,
      onChange: (e) => {
        setValue(e.target.value);
        if (error) setError(null);
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          setValue('');
          setError(null);
          e.currentTarget.blur();
        }
      },
    }),
    error && createElement('p', { className: 'pl-field-error', role: 'alert' }, error),
  );
}

function TodoRowContent({ item, readOnly, onSave, onDelete, onOpen, handle }) {
  const [failed, setFailed] = useState(false);

  const save = (patch) => {
    setFailed(false);
    onSave({ id: item.id, ...patch }, () => setFailed(true));
  };

  const due = item.dueDate
    ? dueLabel(item.dueDate, item.status === 'done' || item.status === 'cancelled')
    : null;

  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'pl-todo-line' },
      handle,
      createElement(Checkbox, {
        checked: item.isDone,
        disabled: readOnly,
        'aria-label': `${item.isDone ? '標為未完成' : '標為完成'}：${item.title}`,
        onChange: (e) => save({ isDone: e.target.checked }),
      }),
      createElement(
        'button',
        {
          type: 'button',
          className: 'pl-todo-title pl-todo-title--btn',
          'aria-label': `開啟待辦詳情：${item.title}`,
          onClick: () => onOpen(item),
        },
        item.title,
      ),
      createElement(StatusChip, {
        status: item.status,
        title: item.title,
        readOnly: readOnly,
        onChange: (status) => save({ status }),
      }),
      due &&
        createElement(
          'span',
          { className: `pl-todo-due${due.overdue ? ' is-overdue' : ''}`, title: '到期日' },
          due.text,
        ),
      createElement(
        'span',
        { className: 'pl-todo-updated' },
        createElement(UpdatedAt, { at: item.updatedAt }),
      ),
      !readOnly &&
        createElement(
          'span',
          { className: 'pl-todo-actions' },
          createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            iconOnly: true,
            icon: 'x',
            'aria-label': `刪除待辦：${item.title}`,
            onClick: () => onDelete(item),
          }),
        ),
    ),
    item.note && createElement('p', { className: 'pl-todo-note' }, item.note),
    failed && createElement('p', { className: 'pl-field-error', role: 'alert' }, SAVE_FAILED),
  );
}

/** 點列上按鈕 / 輸入框以外的空白處也開啟詳情 */
function openFromRowClick(e, open) {
  if (e.target.closest('button, input, a, label, [role="menu"], [role="listbox"]')) return;
  open();
}

function SortableTodoRow({ item, readOnly, selectedId, onSave, onDelete, onMoveBy, onOpen }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: readOnly });

  const onKeyDown = (e) => {
    if (readOnly || isEditableTarget(e.target)) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      onMoveBy(item, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      onDelete(item);
    }
  };

  const handle = readOnly
    ? null
    : createElement(
        'button',
        {
          ref: setActivatorNodeRef,
          type: 'button',
          className: 'pl-todo-handle',
          'aria-label': `拖曳排序：${item.title}`,
          ...attributes,
          ...listeners,
        },
        createElement(GripIcon, null),
      );

  return createElement(
    'li',
    {
      ref: setNodeRef,
      'data-todo-id': item.id,
      className: `pl-todo-row is-${item.status}${isDragging ? ' is-placeholder' : ''}${selectedId === item.id ? ' is-selected' : ''}`,
      style: { transform: CSS.Translate.toString(transform), transition },
      onKeyDown: onKeyDown,
      onClick: (e) => openFromRowClick(e, () => onOpen(item)),
    },
    createElement(TodoRowContent, {
      item: item,
      readOnly: readOnly,
      onSave: onSave,
      onDelete: onDelete,
      onOpen: onOpen,
      handle: handle,
    }),
  );
}

/** 不可排序的列：延後 / 取消、已完成、篩選結果 */
function StaticTodoRow({ item, readOnly, selectedId, onSave, onDelete, onOpen }) {
  return createElement(
    'li',
    {
      'data-todo-id': item.id,
      className: `pl-todo-row is-static is-${item.status}${selectedId === item.id ? ' is-selected' : ''}`,
      onKeyDown: (e) => {
        if (!readOnly && e.key === 'Delete' && !isEditableTarget(e.target)) {
          e.preventDefault();
          onDelete(item);
        }
      },
      onClick: (e) => openFromRowClick(e, () => onOpen(item)),
    },
    createElement(TodoRowContent, {
      item: item,
      readOnly: readOnly,
      onSave: onSave,
      onDelete: onDelete,
      onOpen: onOpen,
    }),
  );
}

/** ↑ ↓：移到相鄰列的同一種控制項（找不到則該列第一個可聚焦元素） */
function onListArrowKeys(e, dragging) {
  if (dragging || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  if (isEditableTarget(e.target)) return;
  const target = e.target;
  const row = target.closest(ROW_SELECTOR);
  if (!row) return;
  const rows = [...e.currentTarget.querySelectorAll(ROW_SELECTOR)];
  const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  const same = [...row.querySelectorAll('button, input')].indexOf(target);
  const candidates = [...next.querySelectorAll('button, input')];
  (candidates[same] ?? candidates[0])?.focus();
}

/* ── 區塊 ─────────────────────── */

export function TodoSection({ userId, readOnly, text }) {
  const q = useTodos(userId);
  const update = useUpdateTodo();
  const del = useDeleteTodo();
  const clear = useClearDoneTodos();
  const [sp, setSp] = useSearchParams();
  const addRef = useRef(null);
  const listRef = useRef(null);
  const returnFocus = useRef(null);
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [live, setLive] = useState('');
  const resumeShortcuts = useRef(null);

  const items = q.data;
  const groups = groupTodos(items ?? []);
  const open = groups.active;
  const done = groups.done;
  const counts = filterCounts(items ?? []);
  const active = activeId != null ? open.find((i) => i.id === activeId) : undefined;
  const todoId = readTodoParam(sp);
  const inspected = todoId != null ? items?.find((i) => i.id === todoId) : undefined;

  /* ── inspector（?todo=<id>） ── */
  const dropTodoParam = () =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('todo');
        return next;
      },
      { replace: true },
    );
  const openTodo = (item) => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body) returnFocus.current = el;
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('todo', String(item.id));
        return next;
      },
      { replace: todoId != null },
    );
  };
  const closeTodo = () => {
    dropTodoParam();
    const back = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus();
      else addRef.current?.focus();
    });
  };

  // C：聚焦新增列（focus 在輸入框時、唯讀檢視、有對話框時不觸發）
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e) => {
      if (e.key !== 'c' && e.key !== 'C') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target) || shortcutsSuspended() || document.querySelector('dialog[open]'))
        return;
      e.preventDefault();
      addRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);

  useEffect(() => () => resumeShortcuts.current?.(), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onSave = (patch, onError) => {
    setActionError(null);
    // mutateAsync：同一個 mutation 連續呼叫時，每一筆的失敗處理都會執行（mutate 的呼叫層回呼只保留最後一次）
    update.mutateAsync(patch).catch(onError);
  };

  const inspectorSave = (patch, cb) => {
    if (inspected == null) return;
    update.mutateAsync({ id: inspected.id, ...patch }).then(
      () => cb?.onSuccess?.(),
      () => cb?.onError?.(),
    );
  };

  const moveTo = (item, to) => {
    const from = open.findIndex((i) => i.id === item.id);
    if (from < 0 || to < 0 || to >= open.length || from === to) return;
    onSave({ id: item.id, sortOrder: sortOrderForMove(open, from, to) }, () =>
      setActionError('排序儲存失敗，請再試一次'),
    );
  };

  const onMoveBy = (item, delta) => {
    const from = open.findIndex((i) => i.id === item.id);
    const to = from + delta;
    if (to < 0 || to >= open.length) return;
    moveTo(item, to);
    setLive(announce.move(to + 1));
    // 列重新排序後讓 focus 留在原本的控制項上
    const focused = document.activeElement;
    requestAnimationFrame(() => focused?.focus());
  };

  const onDelete = (item) => {
    // 刪除後 focus 移到下一列（沒有則上一列，該區已空則新增列 / 區塊標題）
    const rows = [...(listRef.current?.querySelectorAll(ROW_SELECTOR) ?? [])];
    const idx = rows.findIndex((r) => r.dataset.todoId === String(item.id));
    const nextRow = rows[idx + 1] ?? rows[idx - 1];
    const nextId = nextRow?.dataset.todoId;
    setActionError(null);
    if (todoId === item.id) {
      returnFocus.current = null;
      dropTodoParam();
    }
    del.mutateAsync(item.id).catch(() => setActionError('刪除失敗，請再試一次'));
    requestAnimationFrame(() => {
      const el = nextId
        ? listRef.current?.querySelector(`[data-todo-id="${nextId}"] .pl-todo-title--btn`)
        : null;
      if (el) el.focus();
      else if (addRef.current) addRef.current.focus();
      else document.getElementById('pl-todos-title')?.focus();
    });
  };

  const announcements = {
    onDragStart: ({ active: a }) => {
      const i = open.findIndex((x) => x.id === a.id);
      return announce.pickup(open[i]?.title ?? '', i + 1, open.length);
    },
    onDragOver: ({ over }) => {
      if (!over) return undefined;
      return announce.move(open.findIndex((x) => x.id === over.id) + 1);
    },
    onDragEnd: ({ over }) =>
      over ? announce.drop(open.findIndex((x) => x.id === over.id) + 1) : announce.cancel(),
    onDragCancel: () => announce.cancel(),
  };

  const endDrag = () => {
    setActiveId(null);
    resumeShortcuts.current?.();
    resumeShortcuts.current = null;
  };

  const onDragStart = (e) => {
    setActiveId(Number(e.active.id));
    resumeShortcuts.current = suspendGlobalShortcuts();
  };

  const onDragEnd = (e) => {
    endDrag();
    if (!e.over || e.active.id === e.over.id) return;
    const item = open.find((i) => i.id === e.active.id);
    const to = open.findIndex((i) => i.id === e.over.id);
    if (item) moveTo(item, to);
  };

  const rowProps = { readOnly, selectedId: todoId, onSave, onDelete, onMoveBy, onOpen: openTodo };
  const filterLabel = STATUS_FILTERS.find((f) => f.value === filter)?.label ?? '';

  const doneBlock = (forceOpen) =>
    done.length > 0 &&
    createElement(
      'div',
      { className: 'pl-done' },
      createElement(
        'div',
        { className: 'pl-done-head' },
        forceOpen
          ? createElement('span', { className: 'pl-done-toggle' }, '已完成 ', done.length)
          : createElement(
              'button',
              {
                type: 'button',
                className: 'pl-done-toggle',
                'aria-expanded': showDone,
                onClick: () => setShowDone((v) => !v),
              },
              createElement(Icon, { name: showDone ? 'chevronDown' : 'chevronRight' }),
              '已完成 ',
              done.length,
            ),
        !readOnly &&
          createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setConfirmClear(true) },
            '清除已完成',
          ),
      ),
      (showDone || forceOpen) &&
        createElement(
          'ul',
          { className: 'pl-todo-list', 'aria-label': '已完成' },
          done.map((item) => createElement(StaticTodoRow, { key: item.id, item: item, ...rowProps })),
        ),
    );

  let body;
  if (!items && q.isError)
    body = createElement(ErrorState, { error: q.error, onRetry: () => void q.refetch() });
  else if (!items) body = createElement(SkeletonRows, null);
  else if (items.length === 0)
    body = createElement(EmptyState, { icon: 'listCheck', title: text.empty, description: text.emptyDesc });
  else if (filter === 'done') body = createElement('div', { ref: listRef }, doneBlock(true));
  else if (filter !== 'all') {
    const list = filterTodos(items, filter);
    body = createElement(
      'div',
      { ref: listRef, onKeyDown: (e) => onListArrowKeys(e, false) },
      list.length === 0
        ? createElement('p', { className: 'pl-filter-empty' }, '沒有「', filterLabel, '」的待辦')
        : createElement(
            'ul',
            { className: 'pl-todo-list', 'aria-label': `${filterLabel}的待辦` },
            list.map((item) => createElement(StaticTodoRow, { key: item.id, item: item, ...rowProps })),
          ),
    );
  } else
    body = createElement(
      'div',
      { ref: listRef, onKeyDown: (e) => onListArrowKeys(e, activeId != null) },
      createElement(
        DndContext,
        {
          sensors: sensors,
          collisionDetection: closestCenter,
          accessibility: {
            announcements,
            screenReaderInstructions: {
              draggable: '按空白鍵拿起，↑ ↓ 移動，再按空白鍵放下，Esc 取消。',
            },
          },
          onDragStart: onDragStart,
          onDragEnd: onDragEnd,
          onDragCancel: endDrag,
        },
        createElement(
          SortableContext,
          { items: open.map((i) => i.id), strategy: verticalListSortingStrategy },
          createElement(
            'ul',
            { className: 'pl-todo-list', 'aria-label': text.title },
            open.map((item) => createElement(SortableTodoRow, { key: item.id, item: item, ...rowProps })),
          ),
        ),
        createElement(
          DragOverlay,
          null,
          active
            ? createElement(
                'div',
                { className: 'pl-todo-row is-overlay', 'aria-hidden': 'true' },
                createElement(TodoRowContent, {
                  item: active,
                  readOnly: true,
                  onSave: () => undefined,
                  onDelete: () => undefined,
                  onOpen: () => undefined,
                  handle: createElement(
                    'span',
                    { className: 'pl-todo-handle' },
                    createElement(GripIcon, null),
                  ),
                }),
              )
            : null,
        ),
      ),
      groups.parked.length > 0 &&
        createElement(
          'div',
          { className: 'pl-parked' },
          createElement('div', { className: 'pl-parked-head' }, '延後與取消 ', groups.parked.length),
          createElement(
            'ul',
            { className: 'pl-todo-list', 'aria-label': '延後與取消' },
            groups.parked.map((item) =>
              createElement(StaticTodoRow, { key: item.id, item: item, ...rowProps }),
            ),
          ),
        ),
      doneBlock(false),
    );

  return createElement(
    SectionCard,
    {
      id: 'pl-todos-title',
      title: text.title,
      count: items ? open.length : null,
      className: 'pl-card--todos',
    },
    items &&
      items.length > 0 &&
      createElement(
        'div',
        { className: 'pl-filters', role: 'group', 'aria-label': '依狀態篩選' },
        STATUS_FILTERS.map((f) =>
          createElement(
            'button',
            {
              key: f.value,
              type: 'button',
              className: 'pl-filter',
              'aria-label': `篩選${f.label}，${counts[f.value]} 筆`,
              'aria-pressed': filter === f.value,
              onClick: () => setFilter(f.value),
            },
            f.label,
            createElement('span', { className: 'pl-filter-count' }, counts[f.value]),
          ),
        ),
      ),
    !readOnly && createElement(AddTodo, { inputRef: addRef }),
    body,
    actionError &&
      createElement('p', { className: 'pl-field-error pl-section-error', role: 'alert' }, actionError),
    createElement('div', { className: 'sr-only', 'aria-live': 'assertive' }, live),
    todoId != null &&
      createElement(TodoInspector, {
        key: todoId,
        item: inspected,
        loading: !items && !q.isError,
        readOnly: readOnly,
        deleting: del.isPending,
        onClose: closeTodo,
        onSave: inspectorSave,
        onDelete: onDelete,
      }),
    createElement(
      Dialog,
      {
        open: confirmClear,
        onClose: () => setConfirmClear(false),
        title: `刪除 ${done.length} 筆已完成的待辦？`,
        actions: createElement(
          Fragment,
          null,
          createElement(Button, { variant: 'secondary', onClick: () => setConfirmClear(false) }, '取消'),
          createElement(
            Button,
            {
              variant: 'danger',
              loading: clear.isPending,
              onClick: () =>
                clear.mutate(undefined, {
                  onSuccess: () => setConfirmClear(false),
                  onError: () => {
                    setConfirmClear(false);
                    setActionError('清除失敗，請再試一次');
                  },
                }),
            },
            '刪除',
          ),
        ),
      },
      createElement('p', { className: 'm-0' }, '只會刪除狀態為「完成」的待辦；延後與取消的項目會保留。'),
    ),
  );
}
