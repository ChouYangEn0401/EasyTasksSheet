import { createElement, Fragment } from 'preact';
import { useQueryClient } from '../../lib/query.js';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/compat';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { formatDateOnly } from '../../lib/format.js';
import { useProjectsById, useStatusesById } from '../../lib/hooks.js';
import { toast, truncate } from '../../lib/toast.js';
import {
  Avatar,
  Button,
  ColorDot,
  ErrorState,
  Icon,
  Skeleton,
  Spinner,
  StatusBadge,
} from '../../ui/index.js';
import { recordRelationAdd, recordRelationRemove, undoFromToast } from '../undo/linkUndo.js';
import { useDrawerActive } from './drawerActive.js';
import { jumpToTask } from './drawerNav.js';
import { Popover } from './Popover.js';
import { useAddRelation, useRelationSearch, useRemoveRelation, useTaskRelations } from './relationData.js';
import { relationCandidates } from './relationModel.js';

/** 任務詳情抽屜的「相關任務」區（docs/design/task-list.md §13） */
export function RelatedTasks({ task }) {
  const query = useTaskRelations(task.id, useDrawerActive());
  const remove = useRemoveRelation(task.id);
  const add = useAddRelation(task.id);
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState(null);
  const relations = query.data ?? [];

  // mutateAsync().then：連續移除多筆時每一筆都會登記復原並顯示 toast（mutate 的呼叫層回呼只保留最後一次）
  const onRemove = (rel) =>
    void remove
      .mutateAsync(rel)
      .then(() => {
        // 登記到全站復原堆疊（Ctrl+Z）；toast 的「復原」走同一筆
        const entry = recordRelationRemove(qc, task.id, rel);
        toast({
          tone: 'success',
          title: '已移除相關任務',
          description: truncate(rel.task.title),
          action: { label: '復原', onClick: () => undoFromToast(entry) },
          duration: 5000,
        });
      })
      .catch(() => undefined);

  return createElement(
    'div',
    { className: 'task-drawer-section', 'data-testid': 'related-tasks' },
    createElement(
      'div',
      { className: 'tl-section-title' },
      createElement(
        'span',
        null,
        '相關任務',
        relations.length > 0 && createElement('span', { className: 'tr-count' }, relations.length),
      ),
    ),
    query.isPending
      ? createElement(
          'div',
          { className: 'flex flex-col gap-2', 'aria-busy': 'true', 'aria-label': '載入相關任務' },
          createElement(Skeleton, { height: 14, width: '80%' }),
          createElement(Skeleton, { height: 14, width: '60%' }),
        )
      : query.isError && !query.data
        ? createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() })
        : relations.length === 0
          ? createElement(
              'div',
              { className: 'tl-empty tl-drawer-none' },
              '還沒有相關任務，把相關的工作串起來吧',
            )
          : createElement(
              'ul',
              { className: 'tr-list', 'aria-label': '相關任務' },
              relations.map((rel) =>
                createElement(RelationRow, {
                  key: rel.id,
                  rel: rel,
                  from: task,
                  onRemove: () => onRemove(rel),
                }),
              ),
            ),
    createElement(
      Button,
      {
        variant: 'ghost',
        size: 'sm',
        icon: 'plus',
        className: 'tl-drawer-add',
        'aria-expanded': !!anchor,
        onClick: (e) => setAnchor(anchor ? null : e.currentTarget),
      },
      '新增關聯',
    ),
    anchor &&
      createElement(
        Popover,
        { anchor: anchor, onClose: () => setAnchor(null), width: 340, label: '新增相關任務' },
        createElement(RelationSearch, {
          selfId: task.id,
          relatedIds: relations.map((r) => r.task.id),
          onPick: (target) =>
            void add
              .mutateAsync({ targetId: target.id })
              .then((rel) => {
                recordRelationAdd(qc, task.id, rel);
                setAnchor(null);
                anchor.focus();
              })
              .catch(() => undefined),
          busy: add.isPending,
        }),
      ),
  );
}

function StatusDot({ statusId }) {
  const status = useStatusesById().get(statusId);
  const tone = status ? statusTone(status) : 'todo';
  return createElement('span', {
    className: 'tr-dot',
    style: statusStyle(tone),
    title: status?.name,
    'aria-hidden': 'true',
  });
}

function RelationRow({ rel, from, onRemove }) {
  const t = rel.task;
  const statusName = useStatusesById().get(t.statusId)?.name;
  return createElement(
    'li',
    { className: 'tr-row', 'data-deleted': t.deleted || undefined },
    createElement(StatusDot, { statusId: t.statusId }),
    t.deleted
      ? createElement(
          'span',
          { className: 'tr-title tr-title--deleted' },
          createElement('span', { className: 'truncate' }, t.title),
          createElement('span', { className: 'tr-deleted-tag' }, '已刪除'),
        )
      : createElement(
          'button',
          {
            type: 'button',
            className: 'tr-title tr-title--link',
            onClick: () => jumpToTask(from, t.id),
            'aria-label': `開啟相關任務「${t.title}」${statusName ? `，${statusName}` : ''}`,
          },
          createElement('span', { className: 'truncate' }, t.title),
        ),
    t.dueDate && !t.deleted && createElement('span', { className: 'tr-due' }, formatDateOnly(t.dueDate)),
    !t.deleted && createElement(Avatar, { userId: t.assigneeId, size: 'xs' }),
    createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      iconOnly: true,
      icon: 'x',
      className: 'tr-remove',
      'aria-label': `移除相關任務「${t.title}」`,
      onClick: onRemove,
    }),
  );
}

/** 輕量搜尋選單：輸入標題關鍵字即時搜尋；↑↓ 選擇、Enter 加入、Esc 關閉 */
function RelationSearch({ selfId, relatedIds, onPick, busy }) {
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const projects = useProjectsById();

  // 輸入停頓 200ms 後查詢
  useEffect(() => {
    const h = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(h);
  }, [text]);
  useEffect(() => inputRef.current?.focus(), []);

  const search = useRelationSearch(q);
  const results = useMemo(
    () => (q ? relationCandidates(search.data ?? [], selfId, relatedIds) : []),
    [q, search.data, selfId, relatedIds],
  );
  const idx = Math.min(active, Math.max(0, results.length - 1));
  const typing = text.trim() !== q;

  const onKeyDown = (e) => {
    const n = results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActive((idx + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((idx - 1 + n) % n);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (results[idx] && !busy) onPick(results[idx]);
    }
  };

  let body;
  if (!text.trim()) body = createElement('div', { className: 'ui-panel-empty' }, '輸入標題關鍵字搜尋任務');
  else if ((search.isPending && search.fetchStatus !== 'idle') || (typing && !search.data))
    body = createElement(
      'div',
      { className: 'ui-panel-empty tr-search-state' },
      createElement(Spinner, { size: 14 }),
      ' 搜尋中…',
    );
  else if (search.isError)
    body = createElement(
      'div',
      { className: 'ui-panel-empty tr-search-state' },
      '搜尋失敗 ·',
      ' ',
      createElement(
        'button',
        { type: 'button', className: 'tl-linkbtn', onClick: () => void search.refetch() },
        '重試',
      ),
    );
  else if (results.length === 0)
    body = createElement('div', { className: 'ui-panel-empty' }, '找不到可關聯的任務');
  else
    body = results.map((t, i) => {
      const project = projects.get(t.projectId);
      return createElement(
        'div',
        {
          key: t.id,
          id: `${id}-o${i}`,
          role: 'option',
          'aria-selected': i === idx,
          'data-highlighted': i === idx,
          className: 'ui-option tr-option',
          onPointerMove: () => setActive(i),
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => !busy && onPick(t),
        },
        createElement(
          'span',
          { className: 'tr-option-main' },
          createElement('span', { className: 'tr-option-title' }, t.title),
          createElement(
            'span',
            { className: 'tr-option-meta' },
            createElement(ColorDot, { color: project?.color }),
            createElement('span', { className: 'truncate' }, project?.name ?? '—'),
          ),
        ),
        createElement(StatusBadge, { statusId: t.statusId }),
      );
    });

  return createElement(
    'div',
    { className: 'tr-search' },
    createElement(
      'div',
      { className: 'ui-panel-search' },
      createElement(
        'span',
        { className: 'tr-search-input' },
        createElement(Icon, { name: 'search', size: 14 }),
        createElement('input', {
          ref: inputRef,
          className: 'ui-input ui-input--sm',
          placeholder: '搜尋任務標題…',
          value: text,
          role: 'combobox',
          'aria-expanded': results.length > 0,
          'aria-label': '搜尋要關聯的任務',
          'aria-controls': id,
          'aria-autocomplete': 'list',
          'aria-activedescendant': results.length ? `${id}-o${idx}` : undefined,
          onChange: (e) => {
            setText(e.target.value);
            setActive(0);
          },
          onKeyDown: onKeyDown,
        }),
        busy && createElement(Spinner, { size: 14 }),
      ),
    ),
    createElement(
      'div',
      { id: id, role: 'listbox', 'aria-label': '搜尋結果', className: 'ui-panel-list' },
      body,
    ),
  );
}
