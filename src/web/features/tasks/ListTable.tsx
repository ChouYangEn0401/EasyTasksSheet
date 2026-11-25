import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Status } from '../../../shared/projects.ts';
import type { PropertyDef } from '../../../shared/properties.ts';
import type { Task } from '../../../shared/tasks.ts';
import { useProjectsById, useStatuses, useStatusesById, useUsersById } from '../../lib/hooks.ts';
import { fxAttr, isRecentRemote, taskFxKey, useFlip, useItemFx, type ItemFx } from '../../lib/motion.ts';
import { openTask } from '../../lib/openTask.ts';
import { useCan } from '../../lib/permissions.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { Avatar, Badge, ColorDot, Button, Icon, Input, Spinner, StatusBadge } from '../../ui/index.ts';
import { PinButton } from '../personal/PinButton.tsx';
import { openAdminDialog } from './adminUi.ts';
import { TaskPresenceDots } from '../presence/TaskPresence.tsx';
import { BlockedLock } from '../delay-link/DependencyBadge.tsx';
import { flashTask, useUpdateProperty } from './data.ts';
import { EditableField, type EditState } from './EditableField.tsx';
import { ListGroupDnd, ListInsertDnd, ListRowDnd } from './ListDnd.tsx';
import { useListDndHandles } from './listDndContext.ts';
import { useValueText } from './fieldText.ts';
import {
  checkPropertyName,
  fixedWidth,
  gridTemplate,
  groupDefaults,
  isApplicable,
  toggleDoneStatus,
  type ColumnDef,
  type GroupMode,
  type SortState,
  type TaskGroup,
} from './model.ts';
import { ChecklistBadge } from './ChecklistBadge.tsx';
import { Popover } from './Popover.tsx';
import { EditOptionsForm, NewPropertyForm } from './PropertyPanel.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import { RelationBadge } from './RelationBadge.tsx';
import { useFieldCommit, type CommitResult } from './useFieldCommit.ts';

const COLLAPSED_KEY = 'tasks.list.collapsed';

type NavRow =
  | { key: string; kind: 'header' }
  | { key: string; kind: 'group'; group: TaskGroup }
  | { key: string; kind: 'task'; task: Task; group: TaskGroup }
  | { key: string; kind: 'insert'; group: TaskGroup };

type Active = { row: string; col: number };
type Editing = { row: string; col: number; initialText?: string } | null;

function readCollapsed(): string[] {
  try {
    const v = JSON.parse(readStorage(COLLAPSED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const GROUP_KEY_BY_MODE: Record<GroupMode, string | null> = {
  status: 'status',
  assignee: 'assignee',
  project: null,
  none: null,
};

export type ListTableProps = {
  groups: TaskGroup[];
  mode: GroupMode;
  columns: ColumnDef[];
  allTasks: Task[];
  sort: SortState;
  onSort: (key: string, dir: 'asc' | 'desc' | null) => void;
  onHide: (key: string) => void;
  onDeleteProperty: (p: PropertyDef) => void;
  onPropertyCreated: (p: PropertyDef) => void;
  scopeProjectId: number | null;
  selectedId: number | null;
  onSaved: (result: CommitResult) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
};

/** §2–§4、§9：List 表格（role=grid，roving tabindex） */
export function ListTable(props: ListTableProps) {
  const { groups, mode, columns, sort, selectedId, scrollRef } = props;
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [active, setActive] = useState<Active>({ row: 'header', col: 1 });
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ col: ColumnDef; anchor: HTMLElement } | null>(null);
  const [panel, setPanel] = useState<
    | { kind: 'new'; anchor: HTMLElement }
    | { kind: 'options'; anchor: HTMLElement; property: PropertyDef }
    | null
  >(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [headerError, setHeaderError] = useState<{ key: string; message: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusInGrid = useRef(false);
  const lastCol = useRef(1);
  const fx = useItemFx();
  // 他人變更造成的重新排序 / 換群組：以 FLIP 播位置移動。
  // 自己的編輯不移動畫面（避免點擊中的列滑走），只以更新高亮確認。
  useFlip(gridRef, {
    selector: '.tl-row--task[data-task-id]',
    attr: 'data-task-id',
    enabled: !editing,
    shouldAnimate: (id) => isRecentRemote(taskFxKey(Number(id))),
  });
  const statuses = useStatuses().data ?? [];
  const nCols = columns.length;
  // 清單拖曳：任務列最左多一格「拖曳把手」（第 -1 欄）
  const firstTaskCol = useListDndHandles() ? -1 : 0;

  useEffect(() => {
    if (!headerError) return;
    const t = window.setTimeout(() => setHeaderError(null), 4000);
    return () => window.clearTimeout(t);
  }, [headerError]);

  const rows = useMemo<NavRow[]>(() => {
    const out: NavRow[] = [{ key: 'header', kind: 'header' }];
    for (const g of groups) {
      const isCollapsed = mode !== 'none' && collapsed.includes(g.key);
      if (mode !== 'none') out.push({ key: `g:${g.key}`, kind: 'group', group: g });
      if (isCollapsed) continue;
      for (const t of g.tasks) out.push({ key: `t:${t.id}`, kind: 'task', task: t, group: g });
      out.push({ key: `i:${g.key}`, kind: 'insert', group: g });
    }
    return out;
  }, [groups, collapsed, mode]);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const cur: Active = rowIndex.has(active.row) ? active : { row: 'header', col: 1 };

  const colRange = (r: NavRow): [number, number] =>
    r.kind === 'header' ? [1, nCols + 1] : r.kind === 'task' ? [firstTaskCol, nCols] : [0, 0];

  const focusCell = (row: string, col: number) => {
    const r = rows[rowIndex.get(row) ?? -1];
    if (!r) return;
    const [min, max] = colRange(r);
    const c = Math.max(min, Math.min(max, col));
    setActive({ row, col: c });
    const find = () =>
      gridRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(`${row}|${c}`)}"]`);
    const el = find();
    // 已存在則立即 focus（連續按鍵不漏）；否則等下一個 frame（例如剛結束編輯）
    if (el) el.focus();
    else requestAnimationFrame(() => find()?.focus());
  };

  // 編輯使列移動（換群組 / 排序位置）時，focus 跟著該列
  useLayoutEffect(() => {
    if (!focusInGrid.current || editing) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(`${cur.row}|${cur.col}`)}"]`)
      ?.focus();
  });

  const toggleGroup = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    writeStorage(COLLAPSED_KEY, JSON.stringify(next));
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const nav = target.dataset.nav;
    if (!nav) return;
    const i = rowIndex.get(cur.row);
    if (i == null) return;
    const r = rows[i]!;
    const [min, max] = colRange(r);
    const go = (ri: number, col: number) => {
      const nr = rows[Math.max(0, Math.min(rows.length - 1, ri))]!;
      const multi = nr.kind === 'header' || nr.kind === 'task';
      e.preventDefault();
      focusCell(nr.key, multi ? col : 0);
    };
    const colForVertical = r.kind === 'header' || r.kind === 'task' ? cur.col : lastCol.current;
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1, colForVertical);
      case 'ArrowUp':
        return go(i - 1, colForVertical);
      case 'ArrowLeft':
        if (r.kind === 'group') {
          e.preventDefault();
          if (!collapsed.includes(r.group.key)) toggleGroup(r.group.key);
          return;
        }
        if (e.altKey) return;
        e.preventDefault();
        return focusCell(cur.row, Math.max(min, cur.col - 1));
      case 'ArrowRight':
        if (r.kind === 'group') {
          e.preventDefault();
          if (collapsed.includes(r.group.key)) toggleGroup(r.group.key);
          return;
        }
        e.preventDefault();
        return focusCell(cur.row, Math.min(max, cur.col + 1));
      case 'Home':
        if (e.ctrlKey) return go(0, 1);
        e.preventDefault();
        return focusCell(cur.row, min);
      case 'End':
        if (e.ctrlKey) return go(rows.length - 1, nCols);
        e.preventDefault();
        return focusCell(cur.row, max);
      case ' ':
        if (r.kind === 'task' && target.classList.contains('tl-field') && r.task.id > 0) {
          e.preventDefault();
          openTask(r.task.id);
        }
        return;
      case 'Enter':
        if (r.kind === 'group') {
          e.preventDefault();
          toggleGroup(r.group.key);
        } else if (r.kind === 'insert') {
          e.preventDefault();
          target.querySelector('input')?.focus();
        }
        return;
      case 'F6': {
        const drawer = document.querySelector<HTMLElement>('.task-drawer [aria-label="關閉任務詳情"]');
        if (drawer) {
          e.preventDefault();
          drawer.focus();
        }
        return;
      }
    }
  };

  const cellProps = (row: string, col: number) => ({
    'data-nav': `${row}|${col}`,
    tabIndex: cur.row === row && cur.col === col ? 0 : -1,
    onFocus: (e: FocusEvent) => {
      if (e.target !== e.currentTarget) return;
      if (cur.row !== row || cur.col !== col) setActive({ row, col });
      const r = rows[rowIndex.get(row) ?? -1];
      if (r && (r.kind === 'task' || r.kind === 'header')) lastCol.current = col;
    },
  });

  const style = {
    '--tl-cols': gridTemplate(columns),
    '--tl-fixed': `${fixedWidth(columns)}px`,
  } as CSSProperties;

  return (
    <div
      ref={scrollRef}
      className="tl-scroll"
      onFocus={() => (focusInGrid.current = true)}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node))
          focusInGrid.current = false;
      }}
      onPointerDown={() => (focusInGrid.current = true)}
    >
      <div
        ref={gridRef}
        role="grid"
        aria-label="任務清單"
        aria-rowcount={rows.length}
        className="tl-grid"
        style={style}
        onKeyDown={onGridKeyDown}
      >
        {rows.map((r) => {
          if (r.kind === 'header')
            return (
              <HeaderRow
                key="header"
                columns={columns}
                sort={sort}
                cellProps={cellProps}
                renaming={renaming}
                setRenaming={setRenaming}
                headerError={headerError}
                setHeaderError={setHeaderError}
                allProperties={columns.filter((c) => c.property).map((c) => c.property!)}
                onSort={props.onSort}
                onOpenMenu={(col, anchor) => setMenu({ col, anchor })}
                onAdd={(anchor) => setPanel({ kind: 'new', anchor })}
              />
            );
          if (r.kind === 'group')
            return (
              <GroupRow
                key={r.key}
                group={r.group}
                collapsed={collapsed.includes(r.group.key)}
                onToggle={() => toggleGroup(r.group.key)}
                cellProps={cellProps(r.key, 0)}
              />
            );
          if (r.kind === 'insert')
            return (
              <div key={r.key} role="row" className="tl-row tl-row--insert">
                <ListInsertDnd groupKey={r.group.key} />
                <div role="gridcell" className="tl-insert-cell" {...cellProps(r.key, 0)}>
                  <QuickAdd
                    fullWidth
                    bare
                    defaults={groupDefaults(r.group)}
                    label={mode === 'none' ? '新增任務' : `在此群組新增任務`}
                    onEscape={() => focusCell(r.key, 0)}
                  />
                </div>
              </div>
            );
          return (
            <TaskRow
              key={r.key}
              rowKey={r.key}
              task={r.task}
              groupKey={r.group.key}
              columns={columns}
              statuses={statuses}
              selected={selectedId === r.task.id}
              fx={fx.get(taskFxKey(r.task.id))}
              editing={editing?.row === r.key ? editing : null}
              setEditing={(col, next, move) => {
                if (next) setEditing({ row: r.key, col, ...next });
                else {
                  setEditing(null);
                  if (move) focusCell(r.key, col + move);
                }
              }}
              cellProps={cellProps}
              onSaved={(col, result) => {
                props.onSaved(result);
                if (result.ok && !('skipped' in result)) {
                  const moving = col.key === GROUP_KEY_BY_MODE[mode] || col.key === sort?.key;
                  if (moving) flashTask(r.task.id);
                }
              }}
            />
          );
        })}
      </div>
      {menu && (
        <ColumnMenu
          col={menu.col}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onSort={(dir) => props.onSort(menu.col.key, dir)}
          onHide={() => props.onHide(menu.col.key)}
          onRename={() => setRenaming(menu.col.key)}
          onEditOptions={() =>
            menu.col.property &&
            setPanel({ kind: 'options', anchor: menu.anchor, property: menu.col.property })
          }
          onDelete={() => menu.col.property && props.onDeleteProperty(menu.col.property)}
        />
      )}
      {panel && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          width={300}
          label={panel.kind === 'new' ? '新增欄位' : '編輯選項'}
        >
          {panel.kind === 'new' ? (
            <NewPropertyForm
              scopeProjectId={props.scopeProjectId}
              onDone={(p) => {
                setPanel(null);
                if (p) props.onPropertyCreated(p);
              }}
            />
          ) : (
            <EditOptionsForm property={panel.property} tasks={props.allTasks} onDone={() => setPanel(null)} />
          )}
        </Popover>
      )}
    </div>
  );
}

type CellPropsFn = (row: string, col: number) => Record<string, unknown>;

function HeaderRow({
  columns,
  sort,
  cellProps,
  renaming,
  setRenaming,
  headerError,
  setHeaderError,
  allProperties,
  onSort,
  onOpenMenu,
  onAdd,
}: {
  columns: ColumnDef[];
  sort: SortState;
  cellProps: CellPropsFn;
  renaming: string | null;
  setRenaming: (k: string | null) => void;
  headerError: { key: string; message: string } | null;
  setHeaderError: (e: { key: string; message: string } | null) => void;
  allProperties: PropertyDef[];
  onSort: (key: string, dir: 'asc' | 'desc' | null) => void;
  onOpenMenu: (col: ColumnDef, anchor: HTMLElement) => void;
  onAdd: (anchor: HTMLElement) => void;
}) {
  return (
    <div role="row" className="tl-row tl-row--header">
      <div role="columnheader" className="tl-hcell tl-sticky-0" aria-label="完成" />
      {columns.map((c, i) => {
        const sorted = sort?.key === c.key ? sort.dir : null;
        const cycle = () => onSort(c.key, !sorted ? 'asc' : sorted === 'asc' ? 'desc' : null);
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
            className={`tl-hcell${c.kind === 'title' ? ' tl-sticky-1' : ''}${sorted ? ' is-sorted' : ''}${
              c.kind === 'estimate' || c.kind === 'number' ? ' tl-right' : ''
            }`}
            {...cellProps('header', i + 1)}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('.tl-hcell-menu, input')) return;
              if (renaming !== c.key) cycle();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onOpenMenu(c, e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) {
                e.preventDefault();
                cycle();
              } else if (e.key === 'ArrowDown' && e.altKey) {
                e.preventDefault();
                onOpenMenu(c, e.currentTarget);
              }
            }}
          >
            {renaming === c.key && c.property ? (
              <RenameInput
                property={c.property}
                others={allProperties}
                onDone={(err) => {
                  setRenaming(null);
                  if (err) setHeaderError({ key: c.key, message: err });
                }}
              />
            ) : (
              <>
                <span className="tl-hcell-label">{c.label}</span>
                {sorted && <span aria-hidden="true">{sorted === 'asc' ? '↑' : '↓'}</span>}
                <button
                  type="button"
                  className="tl-hcell-menu"
                  tabIndex={-1}
                  aria-label={`${c.label} 欄位選單`}
                  onClick={(e) => onOpenMenu(c, e.currentTarget.parentElement!)}
                >
                  <Icon name="chevronDown" size={14} />
                </button>
              </>
            )}
            {headerError?.key === c.key && (
              <span className="tl-field-error" role="alert">
                {headerError.message}
              </span>
            )}
          </div>
        );
      })}
      <div role="columnheader" className="tl-hcell tl-hcell--add">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="plus"
          aria-label="新增欄位"
          {...(cellProps('header', columns.length + 1) as object)}
          onClick={(e) => onAdd(e.currentTarget)}
        />
      </div>
    </div>
  );
}

function RenameInput({
  property,
  others,
  onDone,
}: {
  property: PropertyDef;
  others: PropertyDef[];
  onDone: (error?: string) => void;
}) {
  const [name, setName] = useState(property.name);
  const update = useUpdateProperty();
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!save || name.trim() === property.name) return onDone();
    const err = checkPropertyName(name, others, property.id);
    if (err) return onDone(err);
    update.mutate({ id: property.id, name: name.trim() }, { onError: (e) => onDone(e.message) });
    onDone();
  };
  return (
    <Input
      size="sm"
      autoFocus
      value={name}
      aria-label="欄位名稱"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

function ColumnMenu({
  col,
  anchor,
  onClose,
  onSort,
  onHide,
  onRename,
  onEditOptions,
  onDelete,
}: {
  col: ColumnDef;
  anchor: HTMLElement;
  onClose: () => void;
  onSort: (dir: 'asc' | 'desc') => void;
  onHide: () => void;
  onRename: () => void;
  onEditOptions: () => void;
  onDelete: () => void;
}) {
  const isSelect = col.kind === 'select' || col.kind === 'multi_select';
  const items: (
    { key: string; label: string; run: () => void; danger?: boolean } | { key: string; sep: true }
  )[] = [
    { key: 'asc', label: '升冪排序', run: () => onSort('asc') },
    { key: 'desc', label: '降冪排序', run: () => onSort('desc') },
  ];
  if (col.property) {
    items.push({ key: 's1', sep: true }, { key: 'rename', label: '重新命名', run: onRename });
    if (isSelect) items.push({ key: 'options', label: '編輯選項', run: onEditOptions });
  }
  if (col.hideable) items.push({ key: 's2', sep: true }, { key: 'hide', label: '隱藏欄位', run: onHide });
  if (col.property) items.push({ key: 'delete', label: '刪除欄位', run: onDelete, danger: true });
  const actionable = items.filter(
    (i): i is Extract<(typeof items)[number], { run: () => void }> => 'run' in i,
  );
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const pick = (run: () => void) => {
    onClose();
    run();
  };
  return (
    <Popover
      anchor={anchor}
      onClose={(reason) => {
        onClose();
        if (reason === 'escape') anchor.focus();
      }}
      width={180}
      role="presentation"
    >
      <div
        ref={ref}
        role="menu"
        aria-label={`${col.label} 欄位選單`}
        tabIndex={-1}
        style={{ outline: 'none' }}
        onKeyDown={(e) => {
          const n = actionable.length;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((idx + 1) % n);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((idx - 1 + n) % n);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick(actionable[idx]!.run);
          } else if (e.key === 'Tab') onClose();
        }}
      >
        {items.map((it) =>
          'sep' in it ? (
            <div key={it.key} className="ui-menu-separator" role="separator" />
          ) : (
            <div
              key={it.key}
              role="menuitem"
              className={`ui-option${it.danger ? ' ui-option--danger' : ''}`}
              data-highlighted={actionable.indexOf(it) === idx}
              onPointerMove={() => setIdx(actionable.indexOf(it))}
              onClick={() => pick(it.run)}
            >
              <span className="ui-option-label">{it.label}</span>
            </div>
          ),
        )}
      </div>
    </Popover>
  );
}

function GroupLabel({ group }: { group: TaskGroup }) {
  const users = useUsersById();
  const projects = useProjectsById();
  if (group.mode === 'status') return <StatusBadge statusId={group.id} />;
  if (group.mode === 'assignee')
    return (
      <span className="tl-person">
        <Avatar userId={group.id} size="xs" tooltip={false} />
        <span>{group.id == null ? '未指派' : (users.get(group.id)?.displayName ?? '—')}</span>
      </span>
    );
  if (group.mode === 'project') {
    const p = group.id != null ? projects.get(group.id) : undefined;
    return (
      <span className="tl-person">
        <ColorDot color={p?.color} size="md" />
        <span>{p?.name ?? '—'}</span>
      </span>
    );
  }
  return null;
}

function groupName(group: TaskGroup, names: { status?: string; user?: string; project?: string }) {
  if (group.mode === 'status') return names.status ?? '';
  if (group.mode === 'assignee') return group.id == null ? '未指派' : (names.user ?? '');
  return names.project ?? '';
}

function GroupRow({
  group,
  collapsed,
  onToggle,
  cellProps,
}: {
  group: TaskGroup;
  collapsed: boolean;
  onToggle: () => void;
  cellProps: Record<string, unknown>;
}) {
  const statuses = useStatusesById();
  const users = useUsersById();
  const projects = useProjectsById();
  const canManageStatuses = useCan('statuses.manage');
  const name = groupName(group, {
    status: group.id != null ? statuses.get(group.id)?.name : undefined,
    user: group.id != null ? users.get(group.id)?.displayName : undefined,
    project: group.id != null ? projects.get(group.id)?.name : undefined,
  });
  return (
    <div role="row" className="tl-row tl-row--group" aria-expanded={!collapsed}>
      <ListGroupDnd group={group} collapsed={collapsed} onExpand={onToggle} />
      <div
        role="gridcell"
        className="tl-group-cell"
        aria-label={`${name}，${group.tasks.length} 筆，${collapsed ? '已收合' : '已展開'}`}
        {...cellProps}
        onClick={onToggle}
      >
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} />
        <GroupLabel group={group} />
        <Badge count>{group.tasks.length}</Badge>
      </div>
      {group.mode === 'status' && canManageStatuses && (
        <div role="gridcell" className="tl-group-add">
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            tabIndex={-1}
            onClick={() => openAdminDialog({ kind: 'add-status' })}
          >
            新增狀態
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  rowKey,
  task,
  groupKey,
  columns,
  statuses,
  selected,
  fx,
  editing,
  setEditing,
  cellProps,
  onSaved,
}: {
  rowKey: string;
  task: Task;
  groupKey: string;
  columns: ColumnDef[];
  statuses: Status[];
  selected: boolean;
  fx: ItemFx | undefined;
  editing: Editing;
  setEditing: (col: number, next: EditState, move?: 1 | -1) => void;
  cellProps: CellPropsFn;
  onSaved: (col: ColumnDef, result: CommitResult) => void;
}) {
  const statusMap = useStatusesById();
  const status = statusMap.get(task.statusId);
  const done = status?.category === 'done';
  const temp = task.id < 0;
  const commit = useFieldCommit();
  const toggleDone = async () => {
    const next = toggleDoneStatus(statuses, task.statusId);
    if (next == null) return;
    const col = columns.find((c) => c.key === 'status') ?? {
      key: 'status',
      kind: 'status' as const,
      label: '狀態',
    };
    const r = await commit(task, col, next);
    onSaved(col as ColumnDef, r);
  };
  return (
    <div
      role="row"
      className="tl-row tl-row--task"
      data-selected={selected || undefined}
      data-done={done || undefined}
      {...fxAttr(fx)}
      data-temp={temp || undefined}
      data-task-id={task.id}
    >
      <div role="gridcell" className="tl-cell tl-cell--check tl-sticky-0">
        <ListRowDnd task={task} groupKey={groupKey} navProps={cellProps(rowKey, -1)} />
        <button
          type="button"
          className="tl-done"
          aria-label="標記為完成"
          aria-pressed={done}
          disabled={temp}
          {...cellProps(rowKey, 0)}
          onClick={() => void toggleDone()}
        >
          {done && <Icon name="check" size={12} strokeWidth={2.5} />}
        </button>
      </div>
      {columns.map((c, i) => (
        <TaskCell
          key={c.key}
          task={task}
          col={c}
          colIndex={i + 1}
          rowKey={rowKey}
          edit={editing?.col === i + 1 ? { initialText: editing.initialText } : null}
          setEditing={setEditing}
          cellProps={cellProps}
          onSaved={onSaved}
        />
      ))}
      <div role="gridcell" className="tl-cell tl-cell--pad" />
    </div>
  );
}

function TaskCell({
  task,
  col,
  colIndex,
  rowKey,
  edit,
  setEditing,
  cellProps,
  onSaved,
}: {
  task: Task;
  col: ColumnDef;
  colIndex: number;
  rowKey: string;
  edit: EditState;
  setEditing: (col: number, next: EditState, move?: 1 | -1) => void;
  cellProps: CellPropsFn;
  onSaved: (col: ColumnDef, result: CommitResult) => void;
}) {
  const valueText = useValueText(task, col);
  const sticky = col.kind === 'title' ? ' tl-sticky-1' : '';
  if (!isApplicable(task, col))
    return (
      <div
        role="gridcell"
        className="tl-cell tl-cell--na"
        title="此欄位不適用於該專案"
        aria-label={`${col.label}：不適用`}
      >
        {null}
      </div>
    );
  const extra: ReactNode =
    col.kind === 'title' ? (
      task.id < 0 ? (
        <span className="tl-row-actions tl-row-actions--show">
          <Spinner size={14} />
        </span>
      ) : (
        <span className="tl-row-actions tl-stop">
          <Button
            variant="ghost"
            size="sm"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              openTask(task.id);
            }}
          >
            開啟
          </Button>
          <PinButton taskId={task.id} size="sm" />
        </span>
      )
    ) : null;
  return (
    <div role="gridcell" className={`tl-cell${sticky}`} title={col.kind === 'title' ? task.title : undefined}>
      <EditableField
        task={task}
        col={col}
        mode="cell"
        edit={edit}
        onEditChange={(next, move) => setEditing(colIndex, next, move)}
        onSaved={(_c, r) => onSaved(col, r)}
        aria-label={`${col.label}：${valueText}`}
        className={col.kind === 'estimate' || col.kind === 'number' ? 'tl-right' : ''}
        {...cellProps(rowKey, colIndex)}
      />
      {col.kind === 'title' && <BlockedLock task={task} mode="list" />}
      {col.kind === 'title' && task.id > 0 && <RelationBadge count={task.relationCount} />}
      {col.kind === 'title' && task.id > 0 && <TaskPresenceDots taskId={task.id} />}
      {col.kind === 'title' && task.id > 0 && <ChecklistBadge task={task} />}
      {extra}
    </div>
  );
}
