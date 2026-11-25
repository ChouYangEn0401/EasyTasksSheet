import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { SelectOption as PropOption } from '../../../shared/properties.ts';
import { TASK_PRIORITIES, type Task } from '../../../shared/tasks.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { isOverdue } from '../../lib/format.ts';
import {
  useProjects,
  useStatuses,
  useStatusesById,
  useUpdateTask,
  useUsers,
  useUsersById,
  useProjectsById,
} from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { Avatar, Badge, Button, Checkbox, ColorDot, Icon, StatusBadge, UpdatedAt } from '../../ui/index.ts';
import { openAdminDialog } from './adminUi.ts';
import {
  checkDateRange,
  formatShortDate,
  getValue,
  parseNumber,
  parseTitle,
  parseUrl,
  PRIORITY_LABELS,
  PRIORITY_TONES,
} from './model.ts';
import { OptionList, Popover, type Opt } from './Popover.tsx';

import { TEXT_KINDS, type FieldCol, type FieldMode } from './fieldText.ts';

export type { FieldCol, FieldMode };

const Dash = () => <span className="tl-empty">—</span>;

function optionTone(o: PropOption | undefined) {
  return o?.color ?? 'gray';
}

/** 欄位值的顯示（唯讀外觀） */
export function FieldDisplay({
  task,
  col,
  mode,
  onToggle,
}: {
  task: Task;
  col: FieldCol;
  mode: FieldMode;
  /** checkbox 切換 */
  onToggle?: (next: boolean) => void;
}) {
  const users = useUsersById();
  const projects = useProjectsById();
  const statuses = useStatusesById();
  const v = getValue(task, col);

  switch (col.kind) {
    case 'title':
      return <span className="tl-title-text">{task.title}</span>;
    case 'status':
      return mode === 'cell' ? (
        <StatusBadge statusId={task.statusId} interactive tabIndex={-1} />
      ) : (
        <StatusBadge statusId={task.statusId} interactive tabIndex={-1} />
      );
    case 'assignee':
    case 'person': {
      if (v == null)
        return col.kind === 'assignee' ? (
          <span className="tl-person">
            <Avatar user={null} size="xs" tooltip={false} />
            <span className="tl-empty">未指派</span>
          </span>
        ) : (
          <Dash />
        );
      const u = users.get(v as number);
      return (
        <span className="tl-person">
          <Avatar userId={v as number} size="xs" tooltip={false} />
          <span className="tl-truncate">{u?.displayName ?? '—'}</span>
        </span>
      );
    }
    case 'project': {
      const p = projects.get(v as number);
      return p ? (
        <span className="tl-person">
          <ColorDot color={p.color} size="md" />
          <span className="tl-truncate">{p.name}</span>
        </span>
      ) : (
        <Dash />
      );
    }
    case 'priority':
      return task.priority === 'none' ? (
        <Dash />
      ) : (
        <Badge tone={PRIORITY_TONES[task.priority]}>{PRIORITY_LABELS[task.priority]}</Badge>
      );
    case 'startDate':
    case 'dueDate':
    case 'date': {
      if (!v) return <Dash />;
      const done = statuses.get(task.statusId)?.category === 'done';
      const overdue = col.kind === 'dueDate' && !done && isOverdue(v as string);
      const text = mode === 'drawer' ? (v as string).replaceAll('-', '/') : formatShortDate(v as string);
      return (
        <span className={`tabular-nums${overdue ? ' tl-overdue' : ''}`}>
          {text}
          {overdue && mode === 'drawer' ? '（已逾期）' : ''}
        </span>
      );
    }
    case 'estimate':
    case 'number':
      if (v == null) return <Dash />;
      return (
        <span className="tabular-nums">
          {String(v)}
          {col.kind === 'estimate' && mode === 'drawer' ? ' 小時' : ''}
        </span>
      );
    case 'text':
      return v ? <span className="tl-truncate">{String(v)}</span> : <Dash />;
    case 'url':
      return v ? (
        <a
          className="tl-link tl-truncate"
          href={String(v)}
          target="_blank"
          rel="noreferrer noopener"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          {String(v)}
        </a>
      ) : (
        <Dash />
      );
    case 'checkbox':
      return (
        <Checkbox
          checked={v === true}
          tabIndex={-1}
          aria-label={col.label}
          onChange={(e) => onToggle?.(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
        />
      );
    case 'select': {
      if (!v) return <Dash />;
      const o = col.property?.options.find((x) => x.id === v);
      return o ? <Badge tone={optionTone(o)}>{o.label}</Badge> : <Dash />;
    }
    case 'multi_select': {
      const ids = (v as string[] | null) ?? [];
      const opts = ids
        .map((id) => col.property?.options.find((o) => o.id === id))
        .filter((o): o is PropOption => !!o);
      if (!opts.length) return <Dash />;
      const max = mode === 'cell' ? 2 : opts.length;
      return (
        <span className="tl-badges">
          {opts.slice(0, max).map((o) => (
            <Badge key={o.id} tone={optionTone(o)}>
              {o.label}
            </Badge>
          ))}
          {opts.length > max && <Badge tone="neutral">+{opts.length - max}</Badge>}
        </span>
      );
    }
    case 'progress':
      return (
        <span className="tl-person">
          <span
            className="progress"
            role="progressbar"
            aria-label="進度"
            aria-valuenow={task.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${task.progress}%` }} />
          </span>
          <span className="tabular-nums text-secondary">{task.progress}%</span>
        </span>
      );
    case 'updatedAt':
      return <UpdatedAt at={task.updatedAt} by={task.updatedBy} />;
  }
}

export type EditorApi = {
  /** 提交並關閉；move 為 Tab 移動方向；refocus=false 表示焦點已移往他處（失焦 / 點外部） */
  submit: (value: unknown, opts?: { move?: 1 | -1; refocus?: boolean }) => void;
  /** 提交但不關閉（多選、進度） */
  submitKeep: (value: unknown) => void;
  cancel: (refocus?: boolean) => void;
  /** 驗證失敗：關閉並在容器顯示錯誤 */
  fail: (message: string, refocus?: boolean) => void;
};

/** 編輯中的欄位（文字類為就地 Input，其餘為錨定在容器下緣的 Popover） */
export function FieldEditor({
  task,
  col,
  mode,
  anchor,
  initialText,
  api,
}: {
  task: Task;
  col: FieldCol;
  mode: FieldMode;
  anchor: HTMLElement | null;
  initialText?: string;
  api: EditorApi;
}) {
  if (TEXT_KINDS.has(col.kind))
    return <TextEditor task={task} col={col} mode={mode} initialText={initialText} api={api} />;
  if (col.kind === 'progress') return <ProgressEditor task={task} api={api} />;
  if (col.kind === 'startDate' || col.kind === 'dueDate' || col.kind === 'date')
    return <DateEditor task={task} col={col} anchor={anchor} api={api} />;
  return <ChoiceEditor task={task} col={col} anchor={anchor} api={api} />;
}

function TextEditor({
  task,
  col,
  mode,
  initialText,
  api,
}: {
  task: Task;
  col: FieldCol;
  mode: FieldMode;
  initialText?: string;
  api: EditorApi;
}) {
  const original = getValue(task, col);
  const [text, setText] = useState(() => initialText ?? (original == null ? '' : String(original)));
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
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

  const finish = (move?: 1 | -1, refocus = true) => {
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

  const onKeyDown = (e: KeyboardEvent) => {
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
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onKeyDown,
    onBlur: () => finish(undefined, false),
  };
  if (multiline) return <textarea ref={ref} rows={1} className="tl-title-input" {...common} />;
  return (
    <input
      ref={ref}
      className={`tl-cell-input${col.kind === 'number' || col.kind === 'estimate' ? ' tl-num' : ''}`}
      inputMode={
        col.kind === 'number' || col.kind === 'estimate' ? 'decimal' : col.kind === 'url' ? 'url' : undefined
      }
      {...common}
    />
  );
}

function ProgressEditor({ task, api }: { task: Task; api: EditorApi }) {
  const [v, setV] = useState(task.progress);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <span className="tl-person" style={{ width: '100%' }}>
      <input
        ref={ref}
        type="range"
        min={0}
        max={100}
        step={5}
        value={v}
        aria-label="進度"
        className="tl-range"
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => api.submitKeep(v)}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') api.submitKeep(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            api.submit(v);
          }
        }}
        onBlur={() => api.submit(v, { refocus: false })}
      />
      <span className="tabular-nums text-secondary" style={{ width: 40 }}>
        {v}%
      </span>
    </span>
  );
}

function DateEditor({
  task,
  col,
  anchor,
  api,
}: {
  task: Task;
  col: FieldCol;
  anchor: HTMLElement | null;
  api: EditorApi;
}) {
  const original = (getValue(task, col) as string | null) ?? '';
  const [value, setValue] = useState(original);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = (next: string | null) => {
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

  return (
    <Popover anchor={anchor} onClose={(r) => api.cancel(r === 'escape')} label={col.label}>
      <div className="tl-date-pop">
        <input
          ref={ref}
          type="date"
          className="ui-input"
          aria-label={col.label}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setValue(v);
            if (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900) commit(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(value || null);
            }
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => commit(null)} disabled={!original}>
          清除
        </Button>
      </div>
    </Popover>
  );
}

function ChoiceEditor({
  task,
  col,
  anchor,
  api,
}: {
  task: Task;
  col: FieldCol;
  anchor: HTMLElement | null;
  api: EditorApi;
}) {
  const statuses = useStatuses().data;
  const users = useUsers().data;
  const projects = useProjects().data;
  const value = getValue(task, col);

  const options = useMemo<Opt<string | number | null>[]>(() => {
    switch (col.kind) {
      case 'status':
        return (statuses ?? []).map((s) => ({
          value: s.id,
          label: s.name,
          leading: (
            <span
              className="ui-dot ui-dot--md"
              style={{ color: 'var(--status-dot)', ...statusStyle(statusTone(s)) }}
            />
          ),
        }));
      case 'assignee':
      case 'person':
        return [
          { value: null, label: '未指派', leading: <Avatar user={null} size="xs" tooltip={false} /> },
          ...(users ?? [])
            .filter((u) => u.isActive || u.id === value)
            .map((u) => ({
              value: u.id,
              label: u.displayName,
              leading: <Avatar user={u} size="xs" tooltip={false} />,
            })),
        ];
      case 'project':
        return (projects ?? [])
          .filter((p) => !p.isArchived || p.id === value)
          .map((p) => ({ value: p.id, label: p.name, leading: <ColorDot color={p.color} size="md" /> }));
      case 'priority':
        return TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
      case 'select':
      case 'multi_select':
        return (col.property?.options ?? []).map((o) => ({
          value: o.id,
          label: o.label,
          leading: <ColorDot color={o.color} size="md" />,
        }));
      default:
        return [];
    }
  }, [col, statuses, users, projects, value]);

  const multiple = col.kind === 'multi_select';
  const [multi, setMulti] = useState<string[]>(() => (Array.isArray(value) ? (value as string[]) : []));
  const selected = multiple ? multi : [value as string | number | null];

  const updateTask = useUpdateTask();
  const canManageStatuses = useCan('statuses.manage');
  const canCreateProject = useCan('projects.create');
  const canManageProjects = useCan('projects.manage');
  const openDialog = (d: Parameters<typeof openAdminDialog>[0]) => {
    api.cancel(false);
    openAdminDialog(d);
  };
  const footerItems: ReactNode[] = [];
  if (col.kind === 'select' && value)
    footerItems.push(
      <button key="clear" type="button" className="ui-option" onClick={() => api.submit(null)}>
        <Icon name="x" />
        <span className="ui-option-label">清除</span>
      </button>,
    );
  if (col.kind === 'status' && canManageStatuses)
    footerItems.push(
      <button
        key="manage-statuses"
        type="button"
        className="ui-option"
        onClick={() => openDialog({ kind: 'manage-statuses' })}
      >
        <Icon name="pencil" />
        <span className="ui-option-label">管理狀態…</span>
      </button>,
    );
  if (col.kind === 'project' && canCreateProject)
    footerItems.push(
      <button
        key="add-project"
        type="button"
        className="ui-option"
        onClick={() =>
          openDialog({
            kind: 'add-project',
            onCreated: (p) => updateTask.mutate({ id: task.id, projectId: p.id }),
          })
        }
      >
        <Icon name="plus" />
        <span className="ui-option-label">新增專案</span>
      </button>,
    );
  if (col.kind === 'project' && canManageProjects)
    footerItems.push(
      <button
        key="manage-projects"
        type="button"
        className="ui-option"
        onClick={() => openDialog({ kind: 'manage-projects' })}
      >
        <Icon name="pencil" />
        <span className="ui-option-label">管理專案…</span>
      </button>,
    );
  const footer = footerItems.length ? <>{footerItems}</> : undefined;

  return (
    <Popover
      anchor={anchor}
      onClose={(r) => api.cancel(r === 'escape')}
      label={col.label}
      width={col.kind === 'status' ? 200 : 240}
    >
      <OptionList
        options={options}
        selected={selected}
        multiple={multiple}
        label={col.label}
        footer={footer}
        onPick={(v) => {
          if (multiple) {
            const id = v as string;
            const next = multi.includes(id) ? multi.filter((x) => x !== id) : [...multi, id];
            setMulti(next);
            api.submitKeep(next.length ? next : null);
          } else api.submit(v);
        }}
      />
    </Popover>
  );
}

/** 只有 children 的簡單容器（Drawer 欄位列） */
export function FieldRowLabel({ children }: { children: ReactNode }) {
  return <span className="task-field-label">{children}</span>;
}
