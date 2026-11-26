import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { ApiError } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useCan } from '../../lib/permissions.js';
import { useProperties, useTask, useUsersById } from '../../lib/hooks.js';
import { fxAttr, motionMs, prefersReducedMotion, useItemFx } from '../../lib/motion.js';
import { closeTask, readTaskParam } from '../../lib/openTask.js';
import { noticeText, useRemoteTaskChanges } from '../../lib/remoteNotice.js';
import { isEditableTarget } from '../../lib/shortcuts.js';
import { notifySuccess, quoteName, truncate } from '../../lib/toast.js';
import { useTaskFilters } from '../../lib/useTaskFilters.js';
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Menu,
  Skeleton,
  Textarea,
  UpdatedAt,
} from '../../ui/index.js';
import { TaskHistorySection } from '../audit/TaskHistorySection.js';
import { PinButton } from '../personal/PinButton.js';
import { DependenciesSection } from '../delay-link/DependenciesSection.js';
import { TaskPresenceHint } from '../presence/TaskPresence.js';
import { reportEditing } from '../../lib/presence.js';
import { useDeleteTaskOptimistic, useOptimisticUpdate } from './data.js';
import { DrawerActiveContext } from './drawerActive.js';
import { backTargetFor, consumeTitleFocus, goBackFrom } from './drawerNav.js';
import { DuplicateDialog } from './DuplicateDialog.js';
import { RelatedTasks } from './RelatedTasks.js';
import { DescriptionLockBanner, DescriptionLockButton } from './DescriptionLock.js';
import { DiscussionSection } from './DiscussionSection.js';
import { EditableField } from './EditableField.js';
import { Checklist } from './Checklist.js';
import { applicableProperties, propertyColumn } from './model.js';
import { Popover } from './Popover.js';
import { NewPropertyForm } from './PropertyPanel.js';

import { withBase } from '../../lib/base.js';

/**
 * 插槽：任務詳情抽屜（T1 升級為可編輯）。
 * 由網址 `?task=<id>` 驅動（以 openTask(id) 開啟）；由 AppShell 全域掛載，任何頁面皆可開啟。
 * 關閉：✕、Esc（編輯中的 Esc 優先取消編輯）、移除 ?task 或瀏覽器上一頁。
 */
export function TaskDrawer() {
  const [sp] = useSearchParams();
  const id = readTaskParam(sp);
  // 關閉時保留最後一個面板播放離場動畫（reduced motion 時直接移除）
  const [lastId, setLastId] = useState(id);
  const [closing, setClosing] = useState(null);
  if (id !== lastId) {
    setLastId(id);
    setClosing(id == null && lastId != null && !prefersReducedMotion() ? lastId : null);
  }
  useEffect(() => {
    if (closing == null) return;
    const t = window.setTimeout(() => setClosing(null), motionMs('--duration-exit'));
    return () => window.clearTimeout(t);
  }, [closing]);
  if (id != null) return createElement(TaskDrawerPanel, { key: id, id: id });
  if (closing != null) return createElement(TaskDrawerPanel, { key: closing, id: closing, leaving: true });
  return null;
}

const FIELDS = [
  { key: 'assignee', label: '負責人', kind: 'assignee' },
  { key: 'project', label: '專案', kind: 'project' },
  { key: 'priority', label: '優先度', kind: 'priority' },
  { key: 'startDate', label: '開始日', kind: 'startDate' },
  { key: 'dueDate', label: '到期日', kind: 'dueDate' },
  { key: 'estimateHours', label: '預估工時', kind: 'estimate' },
  { key: 'progress', label: '進度', kind: 'progress' },
];
const TITLE = { key: 'title', label: '標題', kind: 'title' };
const STATUS = { key: 'status', label: '狀態', kind: 'status' };

function TaskDrawerPanel({ id, leaving = false }) {
  const query = useTask(id);
  const titleId = useId();
  const closeRef = useRef(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [backTo] = useState(() => backTargetFor(id));
  const del = useDeleteTaskOptimistic();
  const usersById = useUsersById();
  const properties = useProperties().data;
  const nameOf = (uid) => (uid != null ? usersById.get(uid)?.displayName : undefined) ?? '其他成員';
  const remote = useRemoteTaskChanges(id, query.data, { properties, nameOf });

  useEffect(() => {
    // 複製任務後切換過來：聚焦標題（資料已預先放入快取）；否則聚焦關閉鈕
    if (consumeTitleFocus(id)) {
      const raf = requestAnimationFrame(() => {
        const title = document.querySelector('.task-drawer .tl-drawer-title-field');
        (title ?? closeRef.current)?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    closeRef.current?.focus();
  }, [id]);

  const hasTask = !!query.data;
  useEffect(() => {
    if (leaving || !hasTask) return;
    // D：在抽屜內（非輸入框、無對話框）開啟複製任務對話框
    const onKey = (e) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target) || document.querySelector('dialog[open]')) return;
      const panel = document.querySelector('.task-drawer:not([data-leaving])');
      if (!panel?.contains(e.target)) return;
      e.preventDefault();
      setDuplicating(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [leaving, hasTask]);

  useEffect(() => {
    if (leaving) return;
    const onKey = (e) => {
      if (e.key === 'F6') {
        // 非 modal 時在清單與 Drawer 間切換 focus
        const panel = document.querySelector('.task-drawer');
        if (panel?.contains(e.target)) {
          const cell = document.querySelector('[role="grid"] [data-nav][tabindex="0"]');
          if (cell) {
            e.preventDefault();
            cell.focus();
          }
        }
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      closeTask();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [leaving]);

  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const deletedByOther = remote.deletedBy !== undefined;
  const task = deletedByOther ? undefined : query.data;

  let body;
  if (deletedByOther)
    body = createElement(EmptyState, {
      title: `此任務已被 ${nameOf(remote.deletedBy ?? null)} 刪除`,
      action: createElement(Button, { variant: 'secondary', onClick: closeTask }, '關閉'),
    });
  else if (query.isPending) body = createElement(DrawerSkeleton, null);
  else if (notFound)
    body = createElement(EmptyState, {
      title: '此任務不存在或已被刪除',
      action: createElement(Button, { variant: 'secondary', onClick: closeTask }, '關閉'),
    });
  else if (query.isError && !task)
    body = createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  else if (task) body = createElement(TaskDetail, { task: task, titleId: titleId });

  return createElement(
    DrawerActiveContext.Provider,
    { value: !leaving },
    createElement('div', { className: 'task-drawer-backdrop', onClick: closeTask, 'aria-hidden': 'true' }),
    createElement(
      'aside',
      {
        className: 'task-drawer',
        'data-leaving': leaving || undefined,
        inert: leaving || undefined,
        'aria-hidden': leaving || undefined,
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': task ? titleId : undefined,
        'aria-label': task ? undefined : '任務詳情',
        tabIndex: -1,
        style: { outline: 'none' },
      },
      createElement(
        'div',
        { className: 'task-drawer-head' },
        backTo &&
          createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: 'tr-back',
              onClick: () => goBackFrom(id),
              'aria-label': `返回「${backTo.title}」`,
              title: `返回「${backTo.title}」`,
            },
            '← 返回 ',
            truncate(backTo.title, 8),
          ),
        createElement('span', { className: 'task-drawer-id' }, '#', id),
        task && createElement(PinButton, { taskId: task.id, size: 'sm' }),
        task &&
          createElement(Menu, {
            align: 'end',
            width: 180,
            label: '更多動作',
            trigger: (p) =>
              createElement(Button, {
                ...p,
                variant: 'ghost',
                size: 'sm',
                iconOnly: true,
                icon: 'menu',
                'aria-label': '更多動作',
              }),
            items: [
              { key: 'duplicate', label: '複製任務（D）', onSelect: () => setDuplicating(true) },
              {
                key: 'copy',
                label: '複製連結',
                onSelect: () =>
                  void navigator.clipboard
                    ?.writeText(`${window.location.origin}${withBase('/tasks/list')}?task=${task.id}`)
                    .catch(() => undefined),
              },
              { key: 'sep', separator: true },
              { key: 'delete', label: '刪除任務', danger: true, onSelect: () => setConfirmDelete(true) },
            ],
          }),
        createElement(Button, {
          ref: closeRef,
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          'aria-label': '關閉任務詳情',
          onClick: closeTask,
        }),
      ),
      task &&
        remote.notice &&
        createElement(
          'div',
          { className: 'rt-notice tl-rt-notice' },
          createElement(
            Alert,
            { tone: 'info', onClose: remote.dismiss },
            remote.notice.actorIds[0] != null &&
              createElement(Avatar, { userId: remote.notice.actorIds[0], size: 'xs', tooltip: false }),
            createElement('span', null, noticeText(remote.notice, nameOf)),
          ),
        ),
      task && !leaving && createElement(TaskPresenceHint, { taskId: task.id }),
      createElement('div', { className: 'task-drawer-body scroll-soft' }, body),
      task &&
        createElement(
          'div',
          { className: 'task-drawer-foot tl-drawer-foot' },
          createElement(UpdatedAt, { at: task.createdAt, by: task.createdBy, prefix: '建立於' }),
          createElement(UpdatedAt, { at: task.updatedAt, by: task.updatedBy, prefix: '更新於' }),
        ),
      task && !leaving && createElement(DiscussionSection, { task: task }),
    ),
    createElement(
      Dialog,
      {
        open: confirmDelete && !!task,
        onClose: () => setConfirmDelete(false),
        role: 'alertdialog',
        title: `刪除任務「${task?.title ?? ''}」？`,
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
              loading: del.isPending,
              onClick: () =>
                task &&
                del.mutate(task.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    closeTask();
                    notifySuccess(`已刪除${quoteName(task.title)}`);
                  },
                }),
            },
            '刪除',
          ),
        ),
      },
      createElement('p', { className: 'm-0' }, '刪除後將從所有檢視中移除。'),
    ),
    task &&
      createElement(DuplicateDialog, { task: task, open: duplicating, onClose: () => setDuplicating(false) }),
  );
}

function FieldRow({ label, fx, children }) {
  return createElement(
    'div',
    { className: 'task-field tl-drawer-field', ...fxAttr(fx) },
    createElement('span', { className: 'task-field-label' }, label),
    children,
  );
}

function TaskDetail({ task, titleId }) {
  const [editing, setEditing] = useState(null);
  const properties = useProperties().data;
  const { filters } = useTaskFilters();
  const [addAnchor, setAddAnchor] = useState(null);
  const custom = applicableProperties(properties ?? [], task.projectId).map(propertyColumn);
  // 他人變更的欄位值播更新高亮（lib/remoteNotice.ts）
  const fxMap = useItemFx();
  const fieldFx = (key) => fxMap.get(`taskfield:${task.id}:${key}`);

  const field = (col, className = '', ariaLabel = col.label) =>
    createElement(EditableField, {
      task: task,
      col: col,
      mode: 'drawer',
      tabIndex: 0,
      'aria-label': ariaLabel ?? undefined,
      className: `tl-drawer-value ${className}`,
      edit: editing?.key === col.key ? editing.state : null,
      onEditChange: (next) => setEditing(next ? { key: col.key, state: next } : null),
    });

  return createElement(
    Fragment,
    null,
    createElement(
      'h2',
      { id: titleId, className: 'task-drawer-title tl-drawer-title', ...fxAttr(fieldFx('title')) },
      field(TITLE, 'tl-drawer-title-field', null),
    ),
    createElement('div', { ...fxAttr(fieldFx('status')) }, field(STATUS, 'tl-drawer-status')),
    createElement(
      'div',
      { className: 'task-drawer-section', style: { marginTop: 16 } },
      FIELDS.map((f) =>
        createElement(FieldRow, { key: f.key, label: f.label, fx: fieldFx(f.key) }, field(f)),
      ),
    ),
    createElement(
      'div',
      { className: 'task-drawer-section' },
      createElement('div', { className: 'tl-section-title' }, '自訂欄位'),
      custom.length === 0 &&
        createElement('div', { className: 'tl-empty tl-drawer-none' }, '尚未建立自訂欄位'),
      custom.map((c) =>
        createElement(FieldRow, { key: c.key, label: c.label, fx: fieldFx(c.key) }, field(c)),
      ),
      createElement(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          icon: 'plus',
          className: 'tl-drawer-add',
          onClick: (e) => setAddAnchor(addAnchor ? null : e.currentTarget),
        },
        '新增欄位',
      ),
      addAnchor &&
        createElement(
          Popover,
          { anchor: addAnchor, onClose: () => setAddAnchor(null), width: 300, label: '新增欄位' },
          createElement(NewPropertyForm, {
            scopeProjectId: filters.project.length === 1 ? filters.project[0] : null,
            onDone: () => setAddAnchor(null),
          }),
        ),
    ),
    createElement(RelatedTasks, { task: task }),
    createElement(DependenciesSection, { task: task }),
    createElement(Description, { task: task, fx: fieldFx('description') }),
    createElement(Checklist, { taskId: task.id }),
    createElement(TaskHistorySection, { taskId: task.id }),
  );
}

/** 描述：失焦或 Ctrl+Enter 儲存；關閉 / 切換任務前先送出未存內容 */
function Description({ task, fx }) {
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  // 描述鎖定（DescriptionLock.tsx）：鎖定中且沒有 tasks.lock 時唯讀（仍可選取複製）
  const canLock = useCan('tasks.lock');
  const readOnly = !!task.descriptionLocked && !canLock;
  const [draft, setDraft] = useState(task.description);
  const [base, setBase] = useState(task.description);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState('idle');
  const ref = useRef(null);
  const latest = useRef({ draft, base, id: task.id, readOnly });
  useEffect(() => {
    latest.current = { draft, base, id: task.id, readOnly };
  });

  // 他人修改（輪詢）：未在編輯且無未存內容時同步；被鎖定成唯讀時捨棄未存內容
  if (task.description !== base && !focused && draft === base && state !== 'saving') {
    setBase(task.description);
    setDraft(task.description);
  } else if (readOnly && draft !== task.description && state !== 'saving') {
    setBase(task.description);
    setDraft(task.description);
  }

  const save = () => {
    if (draft === base || readOnly) return;
    const value = draft;
    setState('saving');
    update.mutate(
      { id: task.id, patch: { description: value }, userId: me?.id },
      {
        onSuccess: () => {
          setBase(value);
          setState('saved');
        },
        onError: () => setState('error'),
      },
    );
  };

  // 在線感知：描述輸入中回報 editing，失焦即回 viewing
  useEffect(() => (focused && !readOnly ? reportEditing(task.id) : undefined), [focused, readOnly, task.id]);

  // 卸載（關閉 Drawer / 切換任務）時送出未存內容
  const mutate = update.mutate;
  useEffect(
    () => () => {
      const { draft: d, base: b, id, readOnly: ro } = latest.current;
      if (d !== b && !ro) mutate({ id, patch: { description: d } });
    },
    [mutate],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(96, el.scrollHeight)}px`;
  }, [draft]);

  return createElement(
    'div',
    { className: 'task-drawer-section', ...fxAttr(fx) },
    createElement(
      'div',
      { className: 'tl-section-title' },
      createElement(
        'span',
        { className: 'lock-toggle' },
        '描述',
        createElement(DescriptionLockButton, { task: task }),
      ),
      createElement(
        'span',
        { className: 'tl-save-state', 'aria-live': 'polite' },
        state === 'saving' && '儲存中…',
        state === 'saved' && '已儲存',
        state === 'error' &&
          createElement(
            'span',
            { className: 'tl-danger-text' },
            '儲存失敗 ·',
            ' ',
            createElement('button', { type: 'button', className: 'tl-linkbtn', onClick: save }, '重試'),
          ),
      ),
    ),
    createElement(DescriptionLockBanner, { task: task }),
    createElement(Textarea, {
      ref: ref,
      value: draft,
      readOnly: readOnly,
      placeholder: readOnly ? '（沒有描述）' : '加入描述…',
      'aria-label': '描述',
      className: 'tl-desc',
      onFocus: () => setFocused(true),
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => {
        setFocused(false);
        save();
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      },
    }),
  );
}

function DrawerSkeleton() {
  return createElement(
    'div',
    { className: 'flex flex-col gap-3', 'aria-busy': 'true', 'aria-label': '載入中' },
    createElement(Skeleton, { height: 24, width: '70%' }),
    createElement(Skeleton, { height: 22, width: 72 }),
    createElement(
      'div',
      { className: 'mt-4 flex flex-col gap-4' },
      Array.from({ length: 6 }, (_, i) =>
        createElement(Skeleton, { key: i, height: 14, width: `${50 + ((i * 13) % 40)}%` }),
      ),
    ),
  );
}
