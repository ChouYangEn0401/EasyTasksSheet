import { createElement, Fragment } from 'preact';
import {
  closestCenter,
  DndContext,
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
import { useEffect, useId, useRef, useState } from 'preact/compat';
import { useQueryClient } from '../../lib/query.js';
import { useCan } from '../../lib/permissions.js';
import { suspendGlobalShortcuts } from '../../lib/shortcuts.js';
import { toast } from '../../lib/toast.js';
import { Button, Checkbox, Dialog, Icon, Input, Skeleton } from '../../ui/index.js';
import { useChecklist, useChecklistActions } from './checklistData.js';
import { useDrawerActive } from './drawerActive.js';
import {
  recordChecklistAdd,
  recordChecklistDelete,
  recordChecklistToggle,
  undoFromToast,
} from '../undo/linkUndo.js';
import {
  MAX_PER_TASK,
  MAX_TEXT,
  parseChecklistText,
  pasteSummary,
  progressOfItems,
  shouldSplitPaste,
  sortOrderAfter,
  sortOrderForMove,
} from './checklistModel.js';

const ROW = '[data-checklist-row]';

/* ── 列內容（顯示 / 就地編輯） ─────────────────────── */

function RowBody({ item, handle, ...a }) {
  const { readOnly } = a;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef(null);
  const textRef = useRef(null);
  const finished = useRef(false);
  const temp = item.id < 0;

  const startEdit = () => {
    if (readOnly || temp) return;
    finished.current = false;
    setDraft(item.text);
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const finish = (commit, refocus = true) => {
    if (finished.current) return;
    finished.current = true;
    const text = draft.trim();
    setEditing(false);
    if (commit && text && text !== item.text) a.onRename(item, text);
    if (refocus) requestAnimationFrame(() => textRef.current?.focus());
  };

  const onInputKey = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const hasText = draft.trim() !== '';
      finish(true, !hasText);
      if (hasText) a.onInsertBelow(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'Backspace' && draft === '') {
      e.preventDefault();
      finished.current = true;
      setEditing(false);
      a.onDelete(item, true);
    }
  };

  return createElement(
    'div',
    { className: 'cl-row-main' },
    handle ?? createElement('span', { className: 'cl-handle-gap', 'aria-hidden': 'true' }),
    createElement(Checkbox, {
      checked: item.isDone,
      disabled: readOnly || temp,
      'aria-label': `${item.isDone ? '標為未完成' : '標為完成'}：${item.text}`,
      onChange: (e) => a.onToggle(item, e.target.checked),
    }),
    editing
      ? createElement('input', {
          ref: inputRef,
          className: 'cl-input',
          value: draft,
          maxLength: MAX_TEXT,
          'aria-label': `編輯待辦：${item.text}`,
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: onInputKey,
          onBlur: () => finish(true, false),
          onPaste: (e) => interceptPaste(e, a.onPaste),
        })
      : createElement(
          'button',
          {
            ref: textRef,
            type: 'button',
            className: 'cl-text',
            'aria-label': readOnly ? item.text : `編輯待辦：${item.text}`,
            onClick: startEdit,
            onKeyDown: (e) => {
              if (e.key === 'F2') {
                e.preventDefault();
                startEdit();
              }
            },
          },
          item.text,
        ),
    !readOnly &&
      !temp &&
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: 'x',
        className: 'cl-del',
        'aria-label': `刪除待辦：${item.text}`,
        onClick: () => a.onDelete(item),
      }),
  );
}

/** 多行貼上：攔截並交給上層確認（單行貼上維持瀏覽器預設） */
function interceptPaste(e, onPaste) {
  const text = e.clipboardData.getData('text/plain');
  if (!shouldSplitPaste(text)) return;
  e.preventDefault();
  onPaste(text);
}

function rowKeyDown(e, item, a) {
  if (a.readOnly) return;
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    e.stopPropagation();
    a.onMove(item, e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'Delete' && e.target.closest('button.cl-text, .cl-handle')) {
    e.preventDefault();
    e.stopPropagation();
    a.onDelete(item);
  }
}

function rowClass(item, extra = '') {
  return `cl-row${item.isDone ? ' is-done' : ''}${item.id < 0 ? ' is-temp' : ''}${extra}`;
}

function SortableRow({ item, ...a }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: a.readOnly || item.id < 0 });
  const handle = a.readOnly
    ? null
    : createElement(
        'button',
        {
          ref: setActivatorNodeRef,
          type: 'button',
          className: 'cl-handle',
          'aria-label': `拖曳排序：${item.text}（或按 Alt 加上下方向鍵）`,
          ...attributes,
          ...listeners,
        },
        createElement(Icon, { name: 'grip', size: 14 }),
      );
  return createElement(
    'li',
    {
      ref: setNodeRef,
      'data-checklist-row': item.id,
      className: rowClass(item, isDragging ? ' is-placeholder' : ''),
      style: { transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null), transition },
      onKeyDown: (e) => rowKeyDown(e, item, a),
    },
    createElement(RowBody, { item: item, handle: handle, ...a }),
  );
}

function StaticRow({ item, ...a }) {
  return createElement(
    'li',
    { 'data-checklist-row': item.id, className: rowClass(item), onKeyDown: (e) => rowKeyDown(e, item, a) },
    createElement(RowBody, { item: item, ...a }),
  );
}

/* ── 「Enter 後在下方新增下一項」的草稿列 ─────────────────────── */

function DraftRow({ onCommit, onClose, onPaste }) {
  const [value, setValue] = useState('');
  const finished = useRef(false);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  const done = (text, keepGoing) => {
    if (finished.current) return;
    finished.current = true;
    if (text) onCommit(text, keepGoing);
    else onClose();
  };
  return createElement(
    'li',
    { className: 'cl-row cl-row--draft', 'data-checklist-draft': true },
    createElement('span', { className: 'cl-handle-gap', 'aria-hidden': 'true' }),
    createElement(Checkbox, { disabled: true, 'aria-hidden': 'true', tabIndex: -1 }),
    createElement('input', {
      ref: ref,
      className: 'cl-input',
      value: value,
      maxLength: MAX_TEXT,
      placeholder: '輸入待辦，Enter 繼續新增，Esc 結束',
      'aria-label': '新增下一項待辦',
      onChange: (e) => setValue(e.target.value),
      onKeyDown: (e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          done(value.trim(), true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done('', false);
        } else if (e.key === 'Backspace' && value === '') {
          e.preventDefault();
          done('', false);
        }
      },
      onBlur: () => done(value.trim(), false),
      onPaste: (e) => interceptPaste(e, onPaste),
    }),
  );
}

/* ── 貼上確認 ─────────────────────── */

function PasteConfirm({ result, existing, onConfirm, onCancel }) {
  const over = existing + result.items.length > MAX_PER_TASK;
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('[data-autofocus]')?.focus();
  }, []);
  return createElement(
    'div',
    {
      ref: ref,
      className: 'cl-paste',
      role: 'group',
      'aria-label': '貼上待辦確認',
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      },
    },
    createElement('div', { className: 'cl-paste-title', role: 'status' }, pasteSummary(result)),
    createElement(
      'ul',
      { className: 'cl-paste-list' },
      result.items
        .slice(0, 5)
        .map((it, i) =>
          createElement(
            'li',
            { key: i },
            createElement('span', { 'aria-hidden': 'true' }, it.isDone ? '☑' : '☐'),
            createElement('span', null, it.text),
          ),
        ),
      result.items.length > 5 && createElement('li', null, '…還有 ', result.items.length - 5, ' 項'),
    ),
    result.overflow > 0 &&
      createElement(
        'p',
        { className: 'cl-paste-note' },
        '一次最多建立 100 項，另有 ',
        result.overflow,
        ' 行未納入。',
      ),
    result.trimmed > 0 &&
      createElement('p', { className: 'cl-paste-note' }, '有 ', result.trimmed, ' 項超過 500 字，已截斷。'),
    over &&
      createElement(
        'p',
        { className: 'cl-paste-note is-error', role: 'alert' },
        '每個任務最多 ',
        MAX_PER_TASK,
        ' 項待辦，無法再加入這麼多。',
      ),
    createElement(
      'div',
      { className: 'cl-paste-actions' },
      createElement(Button, { variant: 'secondary', size: 'sm', onClick: onCancel }, '取消'),
      createElement(
        Button,
        { size: 'sm', disabled: over, onClick: onConfirm, 'data-autofocus': true },
        '建立 ',
        result.items.length,
        ' 項',
      ),
    ),
  );
}

/* ── 新增列 ─────────────────────── */

function AddRow({ disabled, onAdd, onPaste }) {
  const [value, setValue] = useState('');
  return createElement(Input, {
    icon: 'plus',
    size: 'sm',
    value: value,
    maxLength: MAX_TEXT,
    disabled: disabled,
    placeholder: '新增待辦…',
    'aria-label': '新增待辦',
    'data-checklist-add': true,
    onChange: (e) => setValue(e.target.value),
    onKeyDown: (e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = value.trim();
        if (text) {
          onAdd(text);
          setValue('');
        }
      } else if (e.key === 'Escape' && value) {
        e.preventDefault();
        e.stopPropagation();
        setValue('');
      }
    },
    onPaste: (e) => interceptPaste(e, onPaste),
  });
}

/* ── 區塊 ─────────────────────── */

export function Checklist({ taskId }) {
  const q = useChecklist(taskId, useDrawerActive());
  const { add, patch, remove, clearDone } = useChecklistActions(taskId);
  const qc = useQueryClient();
  const canEdit = useCan('tasks.edit');
  const readOnly = !canEdit;
  const titleId = useId();
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(null);
  const [showDone, setShowDone] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [live, setLive] = useState('');
  const rootRef = useRef(null);
  const resume = useRef(null);
  useEffect(() => () => resume.current?.(), []);

  const items = q.data;
  const all = items ?? [];
  const open = all.filter((i) => !i.isDone);
  const done = all.filter((i) => i.isDone);
  const progress = progressOfItems(all);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* 動作 */
  // 成功後才登記復原：用 mutateAsync().then（呼叫層的 mutate(..., { onSuccess }) 連續呼叫時只保留最後一次）；
  // 失敗由全域 toast 提示，這裡吞掉 rejection
  const onToggle = (item, isDone) =>
    void patch
      .mutateAsync({ id: item.id, patch: { isDone } })
      .then(() => void recordChecklistToggle(qc, taskId, item, isDone))
      .catch(() => undefined);
  const onRename = (item, text) => patch.mutate({ id: item.id, patch: { text } });

  const focusRowText = (id) => {
    requestAnimationFrame(() => {
      const el = id
        ? rootRef.current?.querySelector(`[data-checklist-row="${id}"] .cl-text`)
        : rootRef.current?.querySelector('[data-checklist-add] input, input[data-checklist-add]');
      el?.focus();
    });
  };

  const onDelete = (item, focusPrev = false) => {
    const rows = [...(rootRef.current?.querySelectorAll(ROW) ?? [])];
    const idx = rows.findIndex((r) => r.dataset.checklistRow === String(item.id));
    const target = (focusPrev ? rows[idx - 1] : (rows[idx + 1] ?? rows[idx - 1]))?.dataset.checklistRow;
    void remove
      .mutateAsync(item.id)
      .then(() => void recordChecklistDelete(qc, taskId, item))
      .catch(() => undefined);
    focusRowText(target);
  };

  const moveTo = (item, to) => {
    const from = open.findIndex((i) => i.id === item.id);
    if (from < 0 || to < 0 || to >= open.length || from === to) return;
    patch.mutate({ id: item.id, patch: { sortOrder: sortOrderForMove(open, from, to) } });
  };

  const onMove = (item, delta) => {
    if (item.isDone) return;
    const from = open.findIndex((i) => i.id === item.id);
    const to = from + delta;
    if (to < 0 || to >= open.length) return;
    moveTo(item, to);
    setLive(`已移到第 ${to + 1} 項，共 ${open.length} 項`);
    const focused = document.activeElement;
    requestAnimationFrame(() => focused?.focus());
  };

  const addOne = (text, sortOrder) =>
    void add
      .mutateAsync({ items: [{ text }], sortOrder })
      .then((created) => void recordChecklistAdd(qc, taskId, created))
      .catch(() => undefined);

  const onInsertBelow = (item) => setDraft({ afterOrder: item.sortOrder });

  const commitDraft = (text, keepGoing) => {
    const order = sortOrderAfter(all, draft?.afterOrder ?? null);
    addOne(text, order);
    setDraft(keepGoing ? { afterOrder: order } : null);
  };

  const askPaste = (text) => {
    setDraft(null);
    const r = parseChecklistText(text);
    if (r.items.length > 0) setPending(r);
  };

  const confirmPaste = () => {
    if (!pending) return;
    const batch = pending.items;
    setPending(null);
    void add
      .mutateAsync({ items: batch })
      .then((created) => {
        // 同時登記到全站復原堆疊（Ctrl+Z）；toast 的「復原」走同一筆
        const entry = recordChecklistAdd(qc, taskId, created);
        toast({
          key: 'checklist-pasted',
          tone: 'success',
          title: `已建立 ${created.length} 項待辦`,
          action: {
            label: '復原',
            onClick: () =>
              entry?.id != null
                ? undoFromToast(entry)
                : void Promise.all(created.map((c) => remove.mutateAsync(c.id).catch(() => undefined))),
          },
          duration: 8000,
        });
        focusRowText(undefined);
      })
      .catch(() => undefined);
  };

  /* 拖曳 */
  const onDragStart = (_e) => {
    resume.current = suspendGlobalShortcuts();
    // 拖曳中 Esc 只取消拖曳（dnd-kit 自行處理），不讓抽屜關閉：在 window capture 階段先 preventDefault
    // （與清單拖曳 ListDnd、甘特拖曳一致；優先序 Dialog > 拖曳 > 抽屜）
    const onKey = (e) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    const release = resume.current;
    resume.current = () => {
      // 讓本次 Esc 的其他監聽者（抽屜）看完 defaultPrevented 後再移除
      window.setTimeout(() => window.removeEventListener('keydown', onKey, true), 0);
      release();
    };
  };
  const endDrag = () => {
    resume.current?.();
    resume.current = null;
  };
  const onDragEnd = (e) => {
    endDrag();
    if (!e.over || e.active.id === e.over.id) return;
    const item = open.find((i) => i.id === e.active.id);
    const to = open.findIndex((i) => i.id === e.over.id);
    if (item) {
      moveTo(item, to);
      setLive(`已移到第 ${to + 1} 項，共 ${open.length} 項`);
    }
  };

  const rowActions = {
    readOnly,
    onToggle,
    onRename,
    onInsertBelow,
    onDelete,
    onMove,
    onPaste: askPaste,
  };

  /* 開放項目（含草稿列的插入位置） */
  const openRows = [];
  let draftPlaced = false;
  const renderDraft = () =>
    createElement(DraftRow, {
      key: `draft-${draft?.afterOrder}`,
      onCommit: commitDraft,
      onClose: () => setDraft(null),
      onPaste: askPaste,
    });
  for (const item of open) {
    if (draft && !draftPlaced && draft.afterOrder != null && item.sortOrder > draft.afterOrder) {
      openRows.push(renderDraft());
      draftPlaced = true;
    }
    openRows.push(createElement(SortableRow, { key: item.id, item: item, ...rowActions }));
  }
  if (draft && !draftPlaced) openRows.push(renderDraft());

  let body;
  if (!items && q.isError)
    body = createElement(
      'div',
      { className: 'cl-error', role: 'alert' },
      createElement('span', null, '無法載入待辦清單'),
      createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => void q.refetch() }, '重試'),
    );
  else if (!items)
    body = createElement(
      'div',
      { className: 'cl-skeleton', 'aria-busy': 'true', 'aria-label': '載入待辦清單' },
      createElement(Skeleton, { height: 16, width: '70%' }),
      createElement(Skeleton, { height: 16, width: '50%' }),
    );
  else
    body = createElement(
      Fragment,
      null,
      all.length === 0 &&
        !draft &&
        createElement(
          'p',
          { className: 'cl-empty' },
          readOnly
            ? '這個任務還沒有待辦項目'
            : '把工作拆成小步驟，逐項勾選。可在下方輸入，或貼上多行文字快速建立。',
        ),
      (open.length > 0 || draft) &&
        createElement(
          DndContext,
          {
            sensors: sensors,
            collisionDetection: closestCenter,
            accessibility: {
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
            createElement('ul', { className: 'cl-list', 'aria-label': '待辦項目' }, openRows),
          ),
        ),
      done.length > 0 &&
        createElement(
          Fragment,
          null,
          createElement(
            'button',
            {
              type: 'button',
              className: 'cl-done-toggle',
              'aria-expanded': showDone,
              onClick: () => setShowDone((v) => !v),
            },
            createElement(Icon, { name: showDone ? 'chevronDown' : 'chevronRight', size: 14 }),
            '已完成 ',
            done.length,
            ' 項',
          ),
          showDone &&
            createElement(
              'ul',
              { className: 'cl-list', 'aria-label': '已完成的待辦' },
              done.map((item) => createElement(StaticRow, { key: item.id, item: item, ...rowActions })),
            ),
        ),
    );

  return createElement(
    'section',
    {
      ref: rootRef,
      className: 'task-drawer-section cl',
      'aria-labelledby': titleId,
      'data-testid': 'checklist',
    },
    createElement(
      'div',
      { className: 'cl-head' },
      createElement('span', { id: titleId }, '待辦清單'),
      progress.total > 0 &&
        createElement(
          'span',
          { className: 'cl-count', 'data-testid': 'checklist-progress' },
          progress.done,
          ' / ',
          progress.total,
        ),
      createElement(
        'span',
        { className: 'cl-head-end' },
        progress.complete &&
          createElement(
            'span',
            { className: 'cl-complete', role: 'status' },
            createElement(Icon, { name: 'checkCircle', size: 14 }),
            '全部完成',
          ),
        !readOnly &&
          done.length > 0 &&
          createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setConfirmClear(true) },
            '清除已完成',
          ),
      ),
    ),
    progress.total > 0 &&
      createElement(
        'div',
        {
          className: `cl-bar${progress.complete ? ' is-complete' : ''}`,
          role: 'progressbar',
          'aria-label': '待辦清單進度',
          'aria-valuemin': 0,
          'aria-valuemax': progress.total,
          'aria-valuenow': progress.done,
          'aria-valuetext': `${progress.done} / ${progress.total} 完成`,
        },
        createElement('span', { style: { width: `${progress.percent}%` } }),
      ),
    body,
    pending &&
      createElement(PasteConfirm, {
        result: pending,
        existing: all.length,
        onConfirm: confirmPaste,
        onCancel: () => {
          setPending(null);
          focusRowText(undefined);
        },
      }),
    !readOnly &&
      items &&
      createElement(AddRow, {
        disabled: all.length >= MAX_PER_TASK,
        onAdd: (text) => addOne(text),
        onPaste: askPaste,
      }),
    createElement('div', { className: 'sr-only', 'aria-live': 'polite' }, live),
    confirmClear &&
      createElement(ClearDoneDialog, {
        count: done.length,
        loading: clearDone.isPending,
        onCancel: () => setConfirmClear(false),
        onConfirm: () => {
          setConfirmClear(false);
          clearDone.mutate();
        },
      }),
  );
}

function ClearDoneDialog({ count, loading, onCancel, onConfirm }) {
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onCancel,
      role: 'alertdialog',
      title: `清除 ${count} 項已完成的待辦？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onCancel, 'data-autofocus': true }, '取消'),
        createElement(Button, { variant: 'danger', loading: loading, onClick: onConfirm }, '清除'),
      ),
    },
    createElement('p', { className: 'm-0' }, '清除後無法復原。'),
  );
}
