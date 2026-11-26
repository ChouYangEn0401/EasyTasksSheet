import { createElement, Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/compat';
import { TASK_PRIORITIES } from '../../shared/tasks.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { isOverdue } from '../../lib/format.js';
import {
  useProjects,
  useStatuses,
  useStatusesById,
  useUpdateTask,
  useUsers,
  useUsersById,
  useProjectsById,
} from '../../lib/hooks.js';
import { useCan } from '../../lib/permissions.js';
import { Avatar, Badge, Button, Checkbox, ColorDot, Icon, StatusBadge, UpdatedAt } from '../../ui/index.js';
import { openAdminDialog } from './adminUi.js';
import {
  checkDateRange,
  formatShortDate,
  getValue,
  parseNumber,
  parseTitle,
  parseUrl,
  PRIORITY_LABELS,
  PRIORITY_TONES,
} from './model.js';
import { OptionList, Popover } from './Popover.js';

import { TEXT_KINDS } from './fieldText.js';

const Dash = () => createElement('span', { className: 'tl-empty' }, '—');

function optionTone(o) {
  return o?.color ?? 'gray';
}

/** 欄位值的顯示（唯讀外觀） */
export function FieldDisplay({ task, col, mode, onToggle }) {
  const users = useUsersById();
  const projects = useProjectsById();
  const statuses = useStatusesById();
  const v = getValue(task, col);

  switch (col.kind) {
    case 'title':
      return createElement('span', { className: 'tl-title-text' }, task.title);
    case 'status':
      return mode === 'cell'
        ? createElement(StatusBadge, { statusId: task.statusId, interactive: true, tabIndex: -1 })
        : createElement(StatusBadge, { statusId: task.statusId, interactive: true, tabIndex: -1 });
    case 'assignee':
    case 'person': {
      if (v == null)
        return col.kind === 'assignee'
          ? createElement(
              'span',
              { className: 'tl-person' },
              createElement(Avatar, { user: null, size: 'xs', tooltip: false }),
              createElement('span', { className: 'tl-empty' }, '未指派'),
            )
          : createElement(Dash, null);
      const u = users.get(v);
      return createElement(
        'span',
        { className: 'tl-person' },
        createElement(Avatar, { userId: v, size: 'xs', tooltip: false }),
        createElement('span', { className: 'tl-truncate' }, u?.displayName ?? '—'),
      );
    }
    case 'project': {
      const p = projects.get(v);
      return p
        ? createElement(
            'span',
            { className: 'tl-person' },
            createElement(ColorDot, { color: p.color, size: 'md' }),
            createElement('span', { className: 'tl-truncate' }, p.name),
          )
        : createElement(Dash, null);
    }
    case 'priority':
      return task.priority === 'none'
        ? createElement(Dash, null)
        : createElement(Badge, { tone: PRIORITY_TONES[task.priority] }, PRIORITY_LABELS[task.priority]);
    case 'startDate':
    case 'dueDate':
    case 'date': {
      if (!v) return createElement(Dash, null);
      const done = statuses.get(task.statusId)?.category === 'done';
      const overdue = col.kind === 'dueDate' && !done && isOverdue(v);
      const text = mode === 'drawer' ? v.replaceAll('-', '/') : formatShortDate(v);
      return createElement(
        'span',
        { className: `tabular-nums${overdue ? ' tl-overdue' : ''}` },
        text,
        overdue && mode === 'drawer' ? '（已逾期）' : '',
      );
    }
    case 'estimate':
    case 'number':
      if (v == null) return createElement(Dash, null);
      return createElement(
        'span',
        { className: 'tabular-nums' },
        String(v),
        col.kind === 'estimate' && mode === 'drawer' ? ' 小時' : '',
      );
    case 'text':
      return v ? createElement('span', { className: 'tl-truncate' }, String(v)) : createElement(Dash, null);
    case 'url':
      return v
        ? createElement(
            'a',
            {
              className: 'tl-link tl-truncate',
              href: String(v),
              target: '_blank',
              rel: 'noreferrer noopener',
              tabIndex: -1,
              onClick: (e) => e.stopPropagation(),
            },
            String(v),
          )
        : createElement(Dash, null);
    case 'checkbox':
      return createElement(Checkbox, {
        checked: v === true,
        tabIndex: -1,
        'aria-label': col.label,
        onChange: (e) => onToggle?.(e.target.checked),
        onClick: (e) => e.stopPropagation(),
      });
    case 'select': {
      if (!v) return createElement(Dash, null);
      const o = col.property?.options.find((x) => x.id === v);
      return o ? createElement(Badge, { tone: optionTone(o) }, o.label) : createElement(Dash, null);
    }
    case 'multi_select': {
      const ids = v ?? [];
      const opts = ids.map((id) => col.property?.options.find((o) => o.id === id)).filter((o) => !!o);
      if (!opts.length) return createElement(Dash, null);
      const max = mode === 'cell' ? 2 : opts.length;
      return createElement(
        'span',
        { className: 'tl-badges' },
        opts.slice(0, max).map((o) => createElement(Badge, { key: o.id, tone: optionTone(o) }, o.label)),
        opts.length > max && createElement(Badge, { tone: 'neutral' }, '+', opts.length - max),
      );
    }
    case 'progress':
      return createElement(
        'span',
        { className: 'tl-person' },
        createElement(
          'span',
          {
            className: 'progress',
            role: 'progressbar',
            'aria-label': '進度',
            'aria-valuenow': task.progress,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          },
          createElement('span', { style: { width: `${task.progress}%` } }),
        ),
        createElement('span', { className: 'tabular-nums text-secondary' }, task.progress, '%'),
      );
    case 'updatedAt':
      return createElement(UpdatedAt, { at: task.updatedAt, by: task.updatedBy });
  }
}

/** 編輯中的欄位（文字類為就地 Input，其餘為錨定在容器下緣的 Popover） */
export function FieldEditor({ task, col, mode, anchor, initialText, api }) {
  if (TEXT_KINDS.has(col.kind))
    return createElement(TextEditor, {
      task: task,
      col: col,
      mode: mode,
      initialText: initialText,
      api: api,
    });
  if (col.kind === 'progress') return createElement(ProgressEditor, { task: task, api: api });
  if (col.kind === 'startDate' || col.kind === 'dueDate' || col.kind === 'date')
    return createElement(DateEditor, { task: task, col: col, anchor: anchor, api: api });
  return createElement(ChoiceEditor, { task: task, col: col, anchor: anchor, api: api });
}

function TextEditor({ task, col, mode, initialText, api }) {
  const original = getValue(task, col);
  const [text, setText] = useState(() => initialText ?? (original == null ? '' : String(original)));
  const done = useRef(false);
  const ref = useRef(null);
  const multiline = mode === 'drawer' && col.kind === 'title';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (initialText != null) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, [initialText]);

  useLayoutEffect(() => {
    if (!multiline || !ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = `${ref.current.scrollHeight}px`;
  }, [text, multiline]);

  const finish = (move, refocus = true) => {
    if (done.current) return;
    done.current = true;
    const opts = { move, refocus };
    switch (col.kind) {
      case 'title': {
        const r = parseTitle(text);
        // 標題空白 → 不提交並回復
        if (!r.ok) return text.trim() ? api.fail(r.error, refocus) : api.cancel(refocus);
        return api.submit(r.value, opts);
      }
      case 'number':
      case 'estimate': {
        const r = parseNumber(text, { estimate: col.kind === 'estimate' });
        return r.ok ? api.submit(r.value, opts) : api.fail(r.error, refocus);
      }
      case 'url': {
        const r = parseUrl(text);
        return r.ok ? api.submit(r.value, opts) : api.fail(r.error, refocus);
      }
      default:
        return api.submit(text.trim() ? text : null, opts);
    }
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === 'Enter' && multiline) {
      e.preventDefault(); // 標題為單行
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done.current = true;
      api.cancel();
    } else if (e.key === 'Tab' && mode === 'cell') {
      e.preventDefault();
      e.stopPropagation();
      finish(e.shiftKey ? -1 : 1);
    }
    e.stopPropagation();
  };

  const common = {
    value: text,
    'aria-label': col.label,
    onChange: (e) => setText(e.target.value),
    onKeyDown,
    onBlur: () => finish(undefined, false),
  };
  if (multiline)
    return createElement('textarea', { ref: ref, rows: 1, className: 'tl-title-input', ...common });
  return createElement('input', {
    ref: ref,
    className: `tl-cell-input${col.kind === 'number' || col.kind === 'estimate' ? ' tl-num' : ''}`,
    inputMode:
      col.kind === 'number' || col.kind === 'estimate' ? 'decimal' : col.kind === 'url' ? 'url' : undefined,
    ...common,
  });
}

function ProgressEditor({ task, api }) {
  const [v, setV] = useState(task.progress);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return createElement(
    'span',
    { className: 'tl-person', style: { width: '100%' } },
    createElement('input', {
      ref: ref,
      type: 'range',
      min: 0,
      max: 100,
      step: 5,
      value: v,
      'aria-label': '進度',
      className: 'tl-range',
      onChange: (e) => setV(Number(e.target.value)),
      onPointerUp: () => api.submitKeep(v),
      onKeyUp: (e) => {
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') api.submitKeep(v);
      },
      onKeyDown: (e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          api.submit(v);
        }
      },
      onBlur: () => api.submit(v, { refocus: false }),
    }),
    createElement('span', { className: 'tabular-nums text-secondary', style: { width: 40 } }, v, '%'),
  );
}

function DateEditor({ task, col, anchor, api }) {
  const original = getValue(task, col) ?? '';
  const [value, setValue] = useState(original);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = (next) => {
    if (next) {
      const err =
        col.kind === 'startDate'
          ? checkDateRange(next, task.dueDate)
          : col.kind === 'dueDate'
            ? checkDateRange(task.startDate, next)
            : null;
      if (err) return api.fail(err);
    }
    api.submit(next);
  };

  return createElement(
    Popover,
    { anchor: anchor, onClose: (r) => api.cancel(r === 'escape'), label: col.label },
    createElement(
      'div',
      { className: 'tl-date-pop' },
      createElement('input', {
        ref: ref,
        type: 'date',
        className: 'ui-input',
        'aria-label': col.label,
        value: value,
        onChange: (e) => {
          const v = e.target.value;
          setValue(v);
          if (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900) commit(v);
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(value || null);
          }
        },
      }),
      createElement(
        Button,
        { variant: 'ghost', size: 'sm', onClick: () => commit(null), disabled: !original },
        '清除',
      ),
    ),
  );
}

function ChoiceEditor({ task, col, anchor, api }) {
  const statuses = useStatuses().data;
  const users = useUsers().data;
  const projects = useProjects().data;
  const value = getValue(task, col);

  const options = useMemo(() => {
    switch (col.kind) {
      case 'status':
        return (statuses ?? []).map((s) => ({
          value: s.id,
          label: s.name,
          leading: createElement('span', {
            className: 'ui-dot ui-dot--md',
            style: { color: 'var(--status-dot)', ...statusStyle(statusTone(s)) },
          }),
        }));
      case 'assignee':
      case 'person':
        return [
          {
            value: null,
            label: '未指派',
            leading: createElement(Avatar, { user: null, size: 'xs', tooltip: false }),
          },
          ...(users ?? [])
            .filter((u) => u.isActive || u.id === value)
            .map((u) => ({
              value: u.id,
              label: u.displayName,
              leading: createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
            })),
        ];
      case 'project':
        return (projects ?? [])
          .filter((p) => !p.isArchived || p.id === value)
          .map((p) => ({
            value: p.id,
            label: p.name,
            leading: createElement(ColorDot, { color: p.color, size: 'md' }),
          }));
      case 'priority':
        return TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
      case 'select':
      case 'multi_select':
        return (col.property?.options ?? []).map((o) => ({
          value: o.id,
          label: o.label,
          leading: createElement(ColorDot, { color: o.color, size: 'md' }),
        }));
      default:
        return [];
    }
  }, [col, statuses, users, projects, value]);

  const multiple = col.kind === 'multi_select';
  const [multi, setMulti] = useState(() => (Array.isArray(value) ? value : []));
  const selected = multiple ? multi : [value];

  const updateTask = useUpdateTask();
  const canManageStatuses = useCan('statuses.manage');
  const canCreateProject = useCan('projects.create');
  const canManageProjects = useCan('projects.manage');
  const openDialog = (d) => {
    api.cancel(false);
    openAdminDialog(d);
  };
  const footerItems = [];
  if (col.kind === 'select' && value)
    footerItems.push(
      createElement(
        'button',
        { key: 'clear', type: 'button', className: 'ui-option', onClick: () => api.submit(null) },
        createElement(Icon, { name: 'x' }),
        createElement('span', { className: 'ui-option-label' }, '清除'),
      ),
    );
  if (col.kind === 'status' && canManageStatuses)
    footerItems.push(
      createElement(
        'button',
        {
          key: 'manage-statuses',
          type: 'button',
          className: 'ui-option',
          onClick: () => openDialog({ kind: 'manage-statuses' }),
        },
        createElement(Icon, { name: 'pencil' }),
        createElement('span', { className: 'ui-option-label' }, '管理狀態…'),
      ),
    );
  if (col.kind === 'project' && canCreateProject)
    footerItems.push(
      createElement(
        'button',
        {
          key: 'add-project',
          type: 'button',
          className: 'ui-option',
          onClick: () =>
            openDialog({
              kind: 'add-project',
              onCreated: (p) => updateTask.mutate({ id: task.id, projectId: p.id }),
            }),
        },
        createElement(Icon, { name: 'plus' }),
        createElement('span', { className: 'ui-option-label' }, '新增專案'),
      ),
    );
  if (col.kind === 'project' && canManageProjects)
    footerItems.push(
      createElement(
        'button',
        {
          key: 'manage-projects',
          type: 'button',
          className: 'ui-option',
          onClick: () => openDialog({ kind: 'manage-projects' }),
        },
        createElement(Icon, { name: 'pencil' }),
        createElement('span', { className: 'ui-option-label' }, '管理專案…'),
      ),
    );
  const footer = footerItems.length ? createElement(Fragment, null, footerItems) : undefined;

  return createElement(
    Popover,
    {
      anchor: anchor,
      onClose: (r) => api.cancel(r === 'escape'),
      label: col.label,
      width: col.kind === 'status' ? 200 : 240,
    },
    createElement(OptionList, {
      options: options,
      selected: selected,
      multiple: multiple,
      label: col.label,
      footer: footer,
      onPick: (v) => {
        if (multiple) {
          const id = v;
          const next = multi.includes(id) ? multi.filter((x) => x !== id) : [...multi, id];
          setMulti(next);
          api.submitKeep(next.length ? next : null);
        } else api.submit(v);
      },
    }),
  );
}
