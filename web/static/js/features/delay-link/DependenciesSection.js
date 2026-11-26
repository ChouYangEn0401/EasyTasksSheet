import { createElement, Fragment } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { queryClient } from '../../lib/queryClient.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { emptyFilters } from '../../lib/filters.js';
import { todayString } from '../../lib/format.js';
import { useStatusesById, useTasks, useUsersById } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { useCan } from '../../lib/permissions.js';
import { toast, truncate } from '../../lib/toast.js';
import { recordDependencyAdd, recordDependencyRemove, undoFromToast } from '../undo/linkUndo.js';
import { Button, Icon, Input, Skeleton } from '../../ui/index.js';
import { useDrawerActive } from '../tasks/drawerActive.js';
import { Popover } from '../tasks/Popover.js';
import { useCreateDependency, useDeleteDependency, useTaskDependencies } from './api.js';
import { delayPhrase, lagLabel, shortDate } from './depText.js';

/**
 * 任務詳情的「依賴」區（TaskDrawer 最小接入：<DependenciesSection task={task} />）。
 * 兩小節：「等待這些任務完成」（前置任務）與「完成後可開始的任務」。
 * 新增：輕量搜尋選單（標題關鍵字、排除自己與已存在者、最多 8 筆、鍵盤選擇；lag 天數在「進階」）。
 * 移除：一鍵移除，toast 可復原。建立失敗（例如會形成循環）在選單內顯示中文訊息。
 */
export function DependenciesSection({ task }) {
  const q = useTaskDependencies(task.id, useDrawerActive());
  const canEdit = useCan('tasks.edit');
  const [anchor, setAnchor] = useState(null);
  const [initialDir, setInitialDir] = useState('blocked_by');
  const today = todayString();
  const data = q.data;
  const self = data?.self;

  const open = (dir, el) => {
    setInitialDir(dir);
    setAnchor(anchor ? null : el);
  };

  return createElement(
    'section',
    {
      className: 'task-drawer-section',
      'aria-labelledby': `dep-title-${task.id}`,
      'data-testid': 'dep-section',
    },
    createElement(
      'div',
      { className: 'tl-section-title' },
      createElement('span', { id: `dep-title-${task.id}` }, '依賴'),
    ),
    self?.isBlocked && createElement(SelfNotice, { self: self, today: today }),
    q.isPending
      ? createElement(
          'div',
          { className: 'flex flex-col gap-2', 'aria-busy': 'true', 'aria-label': '載入依賴中' },
          createElement(Skeleton, { height: 14, width: '60%' }),
          createElement(Skeleton, { height: 14, width: '45%' }),
        )
      : q.isError && !data
        ? createElement(
            'div',
            { className: 'dep-none', role: 'alert' },
            '無法載入依賴：',
            errorMessage(q.error),
            ' ',
            createElement(
              'button',
              { type: 'button', className: 'tl-linkbtn', onClick: () => void q.refetch() },
              '重試',
            ),
          )
        : createElement(
            Fragment,
            null,
            createElement(DepGroup, {
              title: '等待這些任務完成',
              empty: '沒有前置任務',
              items: data?.blockedBy ?? [],
              taskId: task.id,
              canEdit: canEdit,
              today: today,
              onAdd: (el) => open('blocked_by', el),
              addLabel: '新增前置任務',
            }),
            createElement(DepGroup, {
              title: '完成後可開始的任務',
              empty: '沒有等待此任務的任務',
              items: data?.blocks ?? [],
              taskId: task.id,
              canEdit: canEdit,
              today: today,
              onAdd: (el) => open('blocks', el),
              addLabel: '新增後續任務',
            }),
          ),
    anchor &&
      canEdit &&
      createElement(
        Popover,
        { anchor: anchor, onClose: () => setAnchor(null), width: 340, label: '新增依賴' },
        createElement(DependencyPicker, {
          task: task,
          initialDirection: initialDir,
          existing: [...(data?.blockedBy ?? []), ...(data?.blocks ?? [])].map((d) => d.task.id),
          onDone: () => setAnchor(null),
        }),
      ),
  );
}

function SelfNotice({ self, today }) {
  const text = self.unknownBlockerDate
    ? '等待中（前置任務尚未排程，暫時無法推算）'
    : self.delayDays && self.delayDays > 0
      ? `等待中 · 依前置任務的時程，預計延後 ${self.delayDays} 天（到 ${shortDate(self.projectedEnd, today)}）`
      : self.projectedEnd
        ? `等待中 · 依前置任務的時程，預計 ${shortDate(self.projectedEnd, today)} 完成`
        : '等待中';
  return createElement(
    'div',
    { className: 'dep-self', 'data-testid': 'dep-self' },
    createElement(Icon, { name: 'lock', size: 14 }),
    createElement('span', null, text),
  );
}

function DepGroup({ title, empty, items, taskId, canEdit, today, onAdd, addLabel }) {
  const headingId = useId();
  return createElement(
    'div',
    { className: 'dep-section-group' },
    createElement(
      'div',
      { className: 'dep-subtitle' },
      createElement('span', { id: headingId }, title),
      canEdit &&
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: 'plus',
            'aria-label': addLabel,
            onClick: (e) => onAdd(e.currentTarget),
          },
          '新增',
        ),
    ),
    items.length === 0
      ? createElement('div', { className: 'dep-none' }, empty)
      : createElement(
          'ul',
          { className: 'dep-list', 'aria-labelledby': headingId },
          items.map((d) =>
            createElement(DepRow, { key: d.id, item: d, taskId: taskId, canEdit: canEdit, today: today }),
          ),
        ),
  );
}

function DepRow({ item, taskId, canEdit, today }) {
  const statuses = useStatusesById();
  const users = useUsersById();
  const del = useDeleteDependency(taskId);
  const t = item.task;
  const status = statuses.get(t.statusId);
  const tone = status ? statusTone(status) : 'todo';
  const assignee = t.assigneeId != null ? users.get(t.assigneeId)?.displayName : undefined;
  const dates =
    t.startDate && t.dueDate
      ? `${shortDate(t.startDate, today)}–${shortDate(t.dueDate, today)}`
      : shortDate(t.dueDate ?? t.startDate, today);
  const phrase = t.isDone ? '已完成的前置任務' : delayPhrase(item.projection, today);
  const delayed = !t.isDone && (item.projection.delayDays ?? 0) > 0;

  const remove = () =>
    del.mutate(item.id, {
      onSuccess: (res) => {
        const r = res.removed;
        // 登記到全站復原堆疊（Ctrl+Z）；toast 的「復原」走同一筆（列已卸載，皆直接呼叫 API）
        const entry = recordDependencyRemove(
          queryClient,
          taskId,
          item.id,
          { direction: r.direction, targetId: r.targetId, lagDays: r.lagDays, note: r.note },
          t.title,
        );
        toast({
          tone: 'success',
          title: `已移除依賴「${truncate(t.title)}」`,
          action: { label: '復原', onClick: () => undoFromToast(entry) },
        });
      },
    });

  return createElement(
    'li',
    { className: `dep-row${t.isDone ? ' is-done' : ''}`, 'data-testid': 'dep-row' },
    createElement('span', {
      className: 'dep-row-status',
      style: statusStyle(tone),
      role: 'img',
      'aria-label': `狀態：${status?.name ?? '—'}`,
    }),
    createElement(
      'span',
      { className: 'dep-row-main' },
      createElement(
        'button',
        { type: 'button', className: 'dep-row-title', onClick: () => openTask(t.id), title: t.title },
        t.title,
      ),
      createElement(
        'span',
        { className: 'dep-row-meta' },
        [assignee ?? '未指派', dates].filter(Boolean).join('・'),
        phrase &&
          createElement(
            Fragment,
            null,
            '・',
            createElement(
              'span',
              {
                className: delayed
                  ? 'dep-delay'
                  : item.projection.delayDays === 0 && !t.isDone
                    ? 'dep-ok'
                    : '',
              },
              phrase,
            ),
          ),
        item.lagDays > 0 && `・完成後再等 ${item.lagDays} 天`,
      ),
    ),
    item.lagDays > 0
      ? createElement('span', { className: 'dep-option-hint' }, lagLabel(item.lagDays))
      : createElement('span', null),
    canEdit
      ? createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          className: 'dep-row-remove',
          'aria-label': `移除依賴「${t.title}」`,
          loading: del.isPending,
          onClick: remove,
        })
      : createElement('span', null),
  );
}

const MAX_OPTIONS = 8;

function DependencyPicker({ task, initialDirection, existing, onDone }) {
  const [direction, setDirection] = useState(initialDirection);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [lag, setLag] = useState(0);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const listId = useId();
  const all = useTasks(emptyFilters());
  const statuses = useStatusesById();
  const create = useCreateDependency(task.id);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const options = useMemo(() => {
    const skip = new Set([task.id, ...existing]);
    const kw = query.trim().toLowerCase();
    return (all.data ?? [])
      .filter((t) => t.id > 0 && !skip.has(t.id) && (!kw || t.title.toLowerCase().includes(kw)))
      .slice(0, MAX_OPTIONS);
  }, [all.data, existing, query, task.id]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const pick = (target) => {
    setError(null);
    const input = { direction, targetId: target.id, ...(lag > 0 && { lagDays: lag }) };
    create.mutate(input, {
      onSuccess: (created) => {
        recordDependencyAdd(queryClient, task.id, input, created, target.title);
        toast({
          tone: 'success',
          title: direction === 'blocked_by' ? '已加入前置任務' : '已加入後續任務',
          description: truncate(target.title),
        });
        onDone();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = options[activeIndex];
      if (target && !create.isPending) pick(target);
    }
  };

  return createElement(
    'div',
    { className: 'dep-picker' },
    createElement(
      'div',
      { className: 'dep-picker-dir', role: 'group', 'aria-label': '依賴方向' },
      createElement(
        'button',
        {
          type: 'button',
          'aria-pressed': direction === 'blocked_by',
          onClick: () => setDirection('blocked_by'),
        },
        '等待它完成（前置）',
      ),
      createElement(
        'button',
        { type: 'button', 'aria-pressed': direction === 'blocks', onClick: () => setDirection('blocks') },
        '完成後它才開始（後續）',
      ),
    ),
    createElement(Input, {
      ref: inputRef,
      size: 'sm',
      icon: 'search',
      placeholder: '搜尋任務標題…',
      'aria-label': '搜尋要連結的任務',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': listId,
      'aria-activedescendant': options[activeIndex] ? `${listId}-${options[activeIndex].id}` : undefined,
      'aria-autocomplete': 'list',
      value: query,
      onChange: (e) => {
        setQuery(e.target.value);
        setActive(0);
        setError(null);
      },
      onKeyDown: onKeyDown,
    }),
    createElement(
      'ul',
      { className: 'dep-options', role: 'listbox', id: listId, 'aria-label': '符合的任務' },
      options.length === 0 &&
        createElement(
          'li',
          { className: 'dep-none', role: 'presentation' },
          all.isPending ? '載入中…' : '沒有符合的任務',
        ),
      options.map((t, i) => {
        const s = statuses.get(t.statusId);
        return createElement(
          'li',
          {
            key: t.id,
            id: `${listId}-${t.id}`,
            role: 'option',
            'aria-selected': i === activeIndex,
            className: 'dep-option',
            onMouseEnter: () => setActive(i),
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => !create.isPending && pick(t),
          },
          createElement('span', {
            className: 'dep-row-status',
            style: statusStyle(s ? statusTone(s) : 'todo'),
            'aria-hidden': 'true',
          }),
          createElement('span', { className: 'dep-option-title' }, t.title),
          t.dueDate &&
            createElement('span', { className: 'dep-option-hint' }, shortDate(t.dueDate, todayString())),
        );
      }),
    ),
    createElement(
      'details',
      { className: 'dep-advanced' },
      createElement('summary', null, '進階：完成後再等幾天'),
      createElement(
        'label',
        { className: 'dep-advanced-body' },
        '前置任務完成後，至少再等',
        createElement(Input, {
          size: 'sm',
          type: 'number',
          min: 0,
          max: 365,
          value: lag,
          'aria-label': '等待天數',
          onChange: (e) => setLag(Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0)))),
        }),
        '天',
      ),
    ),
    error && createElement('div', { className: 'dep-error', role: 'alert' }, error),
    create.isPending && createElement('div', { className: 'dep-none' }, '建立中…'),
  );
}
