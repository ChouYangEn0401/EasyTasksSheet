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
import { Link } from '../../lib/router.js';
import { toast, truncate } from '../../lib/toast.js';
import { recordDependencyAdd, recordDependencyRemove, undoFromToast } from '../undo/linkUndo.js';
import { Avatar, Button, Input, Skeleton } from '../../ui/index.js';
import { useDrawerActive } from '../tasks/drawerActive.js';
import { Popover } from '../tasks/Popover.js';
import { useCreateDependency, useDeleteDependency, useTaskDependencies } from './api.js';
import { HourglassIcon } from './DependencyBadge.js';
import { currentWaitId, overdueDays, rowStates, shortDate } from './depText.js';

/** 上游／下游各自超過幾條就先收起來（「還有 N 條」展開） */
const SHOW_MAX = 5;

/**
 * 任務詳情的「相依」區（TaskDrawer 最小接入：<DependenciesSection task={task} />；docs/design/ui-refresh-2026-11-26.md §5.1）。
 * 一條垂直時間線分三段：上游「等待這些完成」→ 本任務 → 下游「完成後可開始」。
 * 每一列：狀態點、標題（點了開那個任務）、負責人、到期日、狀態 pill（逾期 N 天／預計延後 N 天／預計可如期／未排程）；
 * 上游中決定本任務何時能開始的那一條標「目前等待」。右上「看整條鏈 →」帶 ?focus= 到延遲鏈頁。
 * 新增：輕量搜尋選單（標題關鍵字、排除自己與已存在者、最多 8 筆、鍵盤選擇；lag 天數在「進階」）。
 * 移除：一鍵移除，toast 可復原。建立失敗（例如會形成循環）在選單內顯示中文訊息。
 * 語氣（product-principles.md）：「等待中」「前置任務」「預計延後」，不寫「卡住」「拖延」；逾期紅只用在日期事實。
 */
export function DependenciesSection({ task }) {
  const q = useTaskDependencies(task.id, useDrawerActive());
  const canEdit = useCan('tasks.edit');
  const [anchor, setAnchor] = useState(null);
  const [initialDir, setInitialDir] = useState('blocked_by');
  const today = todayString();
  const data = q.data;
  const self = data?.self;
  const up = data?.blockedBy ?? [];
  const down = data?.blocks ?? [];
  const total = up.length + down.length;
  const waitId = useMemo(() => currentWaitId(up), [up]);

  const open = (dir, el) => {
    setInitialDir(dir);
    setAnchor(anchor ? null : el);
  };

  return createElement(
    'section',
    {
      className: 'task-drawer-section dep-section',
      'aria-labelledby': `dep-title-${task.id}`,
      'data-testid': 'dep-section',
    },
    createElement(
      'div',
      { className: 'tl-section-title dep-section-title' },
      createElement(
        'span',
        { id: `dep-title-${task.id}` },
        '相依',
        total > 0 && createElement('span', { className: 'tr-count dep-title-count' }, total),
      ),
      total > 0 &&
        createElement(
          Link,
          {
            to: `/tasks/delay-link?focus=${task.id}`,
            className: 'tl-link dep-chain-link',
            'aria-label': '在延遲鏈頁看整條鏈',
          },
          '看整條鏈 →',
        ),
    ),
    self?.isBlocked && createElement(SelfNotice, { self: self, today: today }),
    q.isPending
      ? createElement(
          'div',
          { className: 'flex flex-col gap-2', 'aria-busy': 'true', 'aria-label': '載入相依中' },
          createElement(Skeleton, { height: 14, width: '60%' }),
          createElement(Skeleton, { height: 14, width: '45%' }),
        )
      : q.isError && !data
        ? createElement(
            'div',
            { className: 'dep-none', role: 'alert' },
            '無法載入相依：',
            errorMessage(q.error),
            ' ',
            createElement(
              'button',
              { type: 'button', className: 'tl-linkbtn', onClick: () => void q.refetch() },
              '重試',
            ),
          )
        : createElement(
            'ol',
            { className: 'dep-chain', 'aria-label': '相依鏈：上游、本任務、下游' },
            createElement(
              'li',
              { className: 'dep-chain-seg dep-chain-seg--up' },
              createElement(DepGroup, {
                title: '等待這些完成',
                hint: '上游',
                empty: '沒有前置任務',
                items: up,
                waitId: waitId,
                taskId: task.id,
                canEdit: canEdit,
                today: today,
                onAdd: (el) => open('blocked_by', el),
                addLabel: '新增前置任務',
              }),
            ),
            createElement(
              'li',
              { className: 'dep-chain-seg dep-chain-seg--self' },
              createElement(SelfRow, { task: task, self: self, today: today }),
            ),
            createElement(
              'li',
              { className: 'dep-chain-seg dep-chain-seg--down' },
              createElement(DepGroup, {
                title: '完成後可開始',
                hint: '下游',
                empty: '沒有等待此任務的任務',
                items: down,
                waitId: null,
                taskId: task.id,
                canEdit: canEdit,
                today: today,
                onAdd: (el) => open('blocks', el),
                addLabel: '新增後續任務',
              }),
            ),
          ),
    anchor &&
      canEdit &&
      createElement(
        Popover,
        { anchor: anchor, onClose: () => setAnchor(null), width: 340, label: '新增依賴' },
        createElement(DependencyPicker, {
          task: task,
          initialDirection: initialDir,
          existing: [...up, ...down].map((d) => d.task.id),
          onDone: () => setAnchor(null),
        }),
      ),
  );
}

function SelfNotice({ self, today }) {
  const n = self.blockedByCount ?? 0;
  const head = n > 0 ? `等待中 · ${n} 個前置任務` : '等待中';
  const text = self.unknownBlockerDate
    ? `${head}（前置任務尚未排程，暫時無法推算）`
    : self.delayDays && self.delayDays > 0
      ? `${head} · 依前置任務的時程，預計延後 ${self.delayDays} 天（到 ${shortDate(self.projectedEnd, today)}）`
      : self.projectedEnd
        ? `${head} · 依前置任務的時程，預計 ${shortDate(self.projectedEnd, today)} 完成`
        : head;
  return createElement(
    'div',
    { className: 'dep-self', 'data-testid': 'dep-self' },
    createElement(HourglassIcon, { size: 14 }),
    createElement('span', null, text),
  );
}

/** 狀態 pill（一列可能兩顆：逾期＝日期事實、預計延後＝推算） */
function StatePills({ states }) {
  return states.map((st) =>
    createElement(
      'span',
      { key: st.tone + st.text, className: `dep-row-state dep-row-state--${st.tone}` },
      st.text,
    ),
  );
}

/** 負責人：頭像＋名字（未指派時虛線頭像＋「未指派」） */
function Person({ userId }) {
  const users = useUsersById();
  const name = userId != null ? users.get(userId)?.displayName : undefined;
  return createElement(
    'span',
    { className: 'dep-row-person' },
    createElement(Avatar, { userId: userId, size: 'xs', tooltip: false }),
    createElement('span', { className: 'dep-row-person-name' }, name ?? '未指派'),
  );
}

function DueText({ task, today, overdue }) {
  if (!task.dueDate)
    return createElement('span', { className: 'dep-row-due dep-row-due--none' }, '未設到期日');
  return createElement(
    'time',
    { className: 'dep-row-due', dateTime: task.dueDate, 'data-overdue': overdue || undefined },
    '到期 ',
    shortDate(task.dueDate, today),
  );
}

function DepGroup({ title, hint, empty, items, waitId, taskId, canEdit, today, onAdd, addLabel }) {
  const headingId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOW_MAX);
  const rest = items.length - shown.length;
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'dep-group-head' },
      createElement(
        'span',
        { id: headingId, className: 'dep-group-title' },
        title,
        createElement('span', { className: 'dep-group-hint' }, `（${hint}）`),
      ),
      createElement(
        'span',
        { className: 'dep-group-count', 'aria-label': `${items.length} 個` },
        items.length,
      ),
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
          shown.map((d) =>
            createElement(DepRow, {
              key: d.id,
              item: d,
              isWait: d.id === waitId,
              taskId: taskId,
              canEdit: canEdit,
              today: today,
            }),
          ),
        ),
    rest > 0 &&
      createElement(
        'button',
        { type: 'button', className: 'tl-linkbtn dep-more', onClick: () => setAll(true) },
        `還有 ${rest} 條`,
      ),
  );
}

/** 本任務那一列：鏈的中段（不可點、沒有動作） */
function SelfRow({ task, self, today }) {
  const statuses = useStatusesById();
  const status = statuses.get(task.statusId);
  const tone = status ? statusTone(status) : 'todo';
  const isDone = status?.category === 'done';
  const od = overdueDays(task.dueDate, today, isDone);
  const states = rowStates({ ...task, isDone: isDone }, self, today);
  return createElement(
    'div',
    {
      className: `dep-row dep-row--self${od > 0 ? ' is-overdue' : ''}`,
      'data-overdue': od > 0 || undefined,
      'aria-current': 'true',
    },
    createElement(
      'span',
      { className: 'dep-node', style: statusStyle(tone) },
      createElement('span', {
        className: 'dep-node-dot',
        role: 'img',
        'aria-label': `本任務，狀態：${status?.name ?? '—'}`,
      }),
    ),
    createElement(
      'div',
      { className: 'dep-row-main' },
      createElement(
        'div',
        { className: 'dep-row-line' },
        createElement('span', { className: 'dep-row-title', title: task.title }, task.title),
        createElement(StatePills, { states: states }),
      ),
      createElement(
        'div',
        { className: 'dep-row-sub' },
        createElement(Person, { userId: task.assigneeId }),
        createElement(DueText, { task: task, today: today, overdue: od > 0 }),
      ),
    ),
  );
}

function DepRow({ item, isWait, taskId, canEdit, today }) {
  const statuses = useStatusesById();
  const del = useDeleteDependency(taskId);
  const t = item.task;
  const status = statuses.get(t.statusId);
  const tone = status ? statusTone(status) : 'todo';
  const od = overdueDays(t.dueDate, today, t.isDone);
  const states = rowStates(t, item.projection, today);

  // 用 mutateAsync：伺服器的即時事件可能比 DELETE 的回應先到，列先被重抓卸載；
  // mutate(…, { onSuccess }) 那層回呼只在元件還掛著時才呼叫，會漏掉「已移除＋復原」的 toast
  const remove = () =>
    del
      .mutateAsync(item.id)
      .then((res) => {
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
      })
      .catch(() => {
        // 失敗訊息由全域 mutation 錯誤 toast 顯示
      });

  return createElement(
    'li',
    {
      className: ['dep-row', t.isDone && 'is-done', isWait && 'is-current-wait', od > 0 && 'is-overdue']
        .filter(Boolean)
        .join(' '),
      'data-testid': 'dep-row',
      'data-overdue': od > 0 || undefined,
    },
    createElement(
      'span',
      { className: 'dep-node', style: statusStyle(tone) },
      createElement('span', {
        className: 'dep-node-dot dep-row-status',
        role: 'img',
        'aria-label': `狀態：${status?.name ?? '—'}`,
      }),
    ),
    createElement(
      'div',
      { className: 'dep-row-main' },
      createElement(
        'div',
        { className: 'dep-row-line' },
        createElement(
          'button',
          { type: 'button', className: 'dep-row-title', onClick: () => openTask(t.id), title: t.title },
          t.title,
        ),
        isWait &&
          createElement(
            'span',
            { className: 'dep-wait-tag', title: '本任務預計何時能開始，取決於這一條' },
            '目前等待',
          ),
        createElement(StatePills, { states: states }),
      ),
      createElement(
        'div',
        { className: 'dep-row-sub' },
        createElement(Person, { userId: t.assigneeId }),
        createElement(DueText, { task: t, today: today, overdue: od > 0 }),
        item.lagDays > 0 &&
          createElement(
            'span',
            { className: 'dep-row-lag', title: `完成後再等 ${item.lagDays} 天` },
            `完成後再等 ${item.lagDays} 天`,
          ),
      ),
    ),
    createElement(
      'span',
      { className: 'dep-row-actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'dep-row-open',
          'aria-label': `開啟「${t.title}」`,
          title: '開啟這個任務',
          onClick: () => openTask(t.id),
        },
        '→',
      ),
      canEdit &&
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          className: 'dep-row-remove',
          'aria-label': `移除依賴「${t.title}」`,
          loading: del.isPending,
          onClick: remove,
        }),
    ),
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
