import { createElement, Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/compat';
import { useProjectsById, useStatuses, useStatusesById, useUsersById } from '../../lib/hooks.js';
import { fxAttr, isRecentRemote, taskFxKey, useFlip, useItemFx } from '../../lib/motion.js';
import { openTask } from '../../lib/openTask.js';
import { useCan } from '../../lib/permissions.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import { statusTone } from '../../lib/colors.js';
import { toDateString, todayString } from '../../lib/format.js';
import { Avatar, Badge, ColorDot, Button, Icon, Input, Spinner, StatusBadge } from '../../ui/index.js';
import { PinButton } from '../personal/PinButton.js';
import { openAdminDialog } from './adminUi.js';
import { TitleBadges } from './TitleBadges.js';
import { flashTask, useUpdateProperty } from './data.js';
import { EditableField } from './EditableField.js';
import { ListGroupDnd, ListInsertDnd, ListRowDnd } from './ListDnd.js';
import { useListDndHandles } from './listDndContext.js';
import { useValueText } from './fieldText.js';
import {
  checkPropertyName,
  fixedWidth,
  gridTemplate,
  groupDefaults,
  isApplicable,
  toggleDoneStatus,
} from './model.js';
import { Popover } from './Popover.js';
import { EditOptionsForm, NewPropertyForm } from './PropertyPanel.js';
import { QuickAdd } from './QuickAdd.js';
import { useFieldCommit } from './useFieldCommit.js';

const COLLAPSED_KEY = 'tasks.list.collapsed';

/**
 * 純顯示：到期日分桶（ui-refresh §3.2 的 data-due）→ overdue／today／week（本週日以前）／later。
 * 已完成或沒有到期日回 null（不套三色）。只給 CSS 上色用，不影響任何邏輯。
 */
function dueBucket(dueDate, done, now = Date.now()) {
  if (!dueDate || done) return null;
  const today = todayString(now);
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  const d = new Date(now);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return dueDate <= toDateString(d) ? 'week' : 'later';
}

function readCollapsed() {
  try {
    const v = JSON.parse(readStorage(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const GROUP_KEY_BY_MODE = {
  status: 'status',
  assignee: 'assignee',
  project: null,
  none: null,
};

/** §2–§4、§9：List 表格（role=grid，roving tabindex） */
export function ListTable(props) {
  const { groups, mode, columns, sort, selectedId, scrollRef } = props;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [active, setActive] = useState({ row: 'header', col: 1 });
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [panel, setPanel] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [headerError, setHeaderError] = useState(null);
  const gridRef = useRef(null);
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

  const rows = useMemo(() => {
    const out = [{ key: 'header', kind: 'header' }];
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
  const cur = rowIndex.has(active.row) ? active : { row: 'header', col: 1 };

  const colRange = (r) =>
    r.kind === 'header' ? [1, nCols + 1] : r.kind === 'task' ? [firstTaskCol, nCols] : [0, 0];

  const focusCell = (row, col) => {
    const r = rows[rowIndex.get(row) ?? -1];
    if (!r) return;
    const [min, max] = colRange(r);
    const c = Math.max(min, Math.min(max, col));
    setActive({ row, col: c });
    const find = () => gridRef.current?.querySelector(`[data-nav="${CSS.escape(`${row}|${c}`)}"]`);
    const el = find();
    // 已存在則立即 focus（連續按鍵不漏）；否則等下一個 frame（例如剛結束編輯）
    if (el) el.focus();
    else requestAnimationFrame(() => find()?.focus());
  };

  // 編輯使列移動（換群組 / 排序位置）時，focus 跟著該列
  useLayoutEffect(() => {
    if (!focusInGrid.current || editing) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    gridRef.current?.querySelector(`[data-nav="${CSS.escape(`${cur.row}|${cur.col}`)}"]`)?.focus();
  });

  const toggleGroup = (key) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    writeStorage(COLLAPSED_KEY, JSON.stringify(next));
  };

  const onGridKeyDown = (e) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const target = e.target;
    const nav = target.dataset.nav;
    if (!nav) return;
    const i = rowIndex.get(cur.row);
    if (i == null) return;
    const r = rows[i];
    const [min, max] = colRange(r);
    const go = (ri, col) => {
      const nr = rows[Math.max(0, Math.min(rows.length - 1, ri))];
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
        const drawer = document.querySelector('.task-drawer [aria-label="關閉任務詳情"]');
        if (drawer) {
          e.preventDefault();
          drawer.focus();
        }
        return;
      }
    }
  };

  const cellProps = (row, col) => ({
    'data-nav': `${row}|${col}`,
    tabIndex: cur.row === row && cur.col === col ? 0 : -1,
    onFocus: (e) => {
      if (e.target !== e.currentTarget) return;
      if (cur.row !== row || cur.col !== col) setActive({ row, col });
      const r = rows[rowIndex.get(row) ?? -1];
      if (r && (r.kind === 'task' || r.kind === 'header')) lastCol.current = col;
    },
  });

  const style = {
    '--tl-cols': gridTemplate(columns),
    '--tl-fixed': `${fixedWidth(columns)}px`,
  };

  return createElement(
    'div',
    {
      ref: scrollRef,
      className: 'tl-scroll',
      onFocus: () => (focusInGrid.current = true),
      onBlur: (e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focusInGrid.current = false;
      },
      onPointerDown: () => (focusInGrid.current = true),
    },
    createElement(
      'div',
      {
        ref: gridRef,
        role: 'grid',
        'aria-label': '任務清單',
        'aria-rowcount': rows.length,
        className: 'tl-grid',
        style: style,
        onKeyDown: onGridKeyDown,
      },
      rows.map((r) => {
        if (r.kind === 'header')
          return createElement(HeaderRow, {
            key: 'header',
            columns: columns,
            sort: sort,
            cellProps: cellProps,
            renaming: renaming,
            setRenaming: setRenaming,
            headerError: headerError,
            setHeaderError: setHeaderError,
            allProperties: columns.filter((c) => c.property).map((c) => c.property),
            onSort: props.onSort,
            onOpenMenu: (col, anchor) => setMenu({ col, anchor }),
            onAdd: (anchor) => setPanel({ kind: 'new', anchor }),
          });
        if (r.kind === 'group')
          return createElement(GroupRow, {
            key: r.key,
            group: r.group,
            collapsed: collapsed.includes(r.group.key),
            onToggle: () => toggleGroup(r.group.key),
            cellProps: cellProps(r.key, 0),
          });
        if (r.kind === 'insert')
          return createElement(
            'div',
            { key: r.key, role: 'row', className: 'tl-row tl-row--insert' },
            createElement(ListInsertDnd, { groupKey: r.group.key }),
            createElement(
              'div',
              { role: 'gridcell', className: 'tl-insert-cell', ...cellProps(r.key, 0) },
              createElement(QuickAdd, {
                fullWidth: true,
                bare: true,
                defaults: groupDefaults(r.group),
                label: mode === 'none' ? '新增任務' : `在此群組新增任務`,
                onEscape: () => focusCell(r.key, 0),
              }),
            ),
          );
        return createElement(TaskRow, {
          key: r.key,
          rowKey: r.key,
          task: r.task,
          groupKey: r.group.key,
          columns: columns,
          statuses: statuses,
          selected: selectedId === r.task.id,
          fx: fx.get(taskFxKey(r.task.id)),
          editing: editing?.row === r.key ? editing : null,
          setEditing: (col, next, move) => {
            if (next) setEditing({ row: r.key, col, ...next });
            else {
              setEditing(null);
              if (move) focusCell(r.key, col + move);
            }
          },
          cellProps: cellProps,
          onSaved: (col, result) => {
            props.onSaved(result);
            if (result.ok && !('skipped' in result)) {
              const moving = col.key === GROUP_KEY_BY_MODE[mode] || col.key === sort?.key;
              if (moving) flashTask(r.task.id);
            }
          },
        });
      }),
    ),
    menu &&
      createElement(ColumnMenu, {
        col: menu.col,
        anchor: menu.anchor,
        onClose: () => setMenu(null),
        onSort: (dir) => props.onSort(menu.col.key, dir),
        onHide: () => props.onHide(menu.col.key),
        onRename: () => setRenaming(menu.col.key),
        onEditOptions: () =>
          menu.col.property &&
          setPanel({ kind: 'options', anchor: menu.anchor, property: menu.col.property }),
        onDelete: () => menu.col.property && props.onDeleteProperty(menu.col.property),
      }),
    panel &&
      createElement(
        Popover,
        {
          anchor: panel.anchor,
          onClose: () => setPanel(null),
          width: 300,
          label: panel.kind === 'new' ? '新增欄位' : '編輯選項',
        },
        panel.kind === 'new'
          ? createElement(NewPropertyForm, {
              scopeProjectId: props.scopeProjectId,
              onDone: (p) => {
                setPanel(null);
                if (p) props.onPropertyCreated(p);
              },
            })
          : createElement(EditOptionsForm, {
              property: panel.property,
              tasks: props.allTasks,
              onDone: () => setPanel(null),
            }),
      ),
  );
}

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
}) {
  return createElement(
    'div',
    { role: 'row', className: 'tl-row tl-row--header' },
    createElement('div', { role: 'columnheader', className: 'tl-hcell tl-sticky-0', 'aria-label': '完成' }),
    columns.map((c, i) => {
      const sorted = sort?.key === c.key ? sort.dir : null;
      const cycle = () => onSort(c.key, !sorted ? 'asc' : sorted === 'asc' ? 'desc' : null);
      return createElement(
        'div',
        {
          key: c.key,
          role: 'columnheader',
          'aria-sort': sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none',
          className: `tl-hcell${c.kind === 'title' ? ' tl-sticky-1' : ''}${sorted ? ' is-sorted' : ''}${c.kind === 'estimate' || c.kind === 'number' ? ' tl-right' : ''}`,
          ...cellProps('header', i + 1),
          onClick: (e) => {
            if (e.target.closest('.tl-hcell-menu, input')) return;
            if (renaming !== c.key) cycle();
          },
          onContextMenu: (e) => {
            e.preventDefault();
            onOpenMenu(c, e.currentTarget);
          },
          onKeyDown: (e) => {
            if (e.target !== e.currentTarget) return;
            if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) {
              e.preventDefault();
              cycle();
            } else if (e.key === 'ArrowDown' && e.altKey) {
              e.preventDefault();
              onOpenMenu(c, e.currentTarget);
            }
          },
        },
        renaming === c.key && c.property
          ? createElement(RenameInput, {
              property: c.property,
              others: allProperties,
              onDone: (err) => {
                setRenaming(null);
                if (err) setHeaderError({ key: c.key, message: err });
              },
            })
          : createElement(
              Fragment,
              null,
              createElement('span', { className: 'tl-hcell-label' }, c.label),
              sorted && createElement('span', { 'aria-hidden': 'true' }, sorted === 'asc' ? '↑' : '↓'),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'tl-hcell-menu',
                  tabIndex: -1,
                  'aria-label': `${c.label} 欄位選單`,
                  onClick: (e) => onOpenMenu(c, e.currentTarget.parentElement),
                },
                createElement(Icon, { name: 'chevronDown', size: 14 }),
              ),
            ),
        headerError?.key === c.key &&
          createElement('span', { className: 'tl-field-error', role: 'alert' }, headerError.message),
      );
    }),
    createElement(
      'div',
      { role: 'columnheader', className: 'tl-hcell tl-hcell--add' },
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: 'plus',
        'aria-label': '新增欄位',
        ...cellProps('header', columns.length + 1),
        onClick: (e) => onAdd(e.currentTarget),
      }),
    ),
  );
}

function RenameInput({ property, others, onDone }) {
  const [name, setName] = useState(property.name);
  const update = useUpdateProperty();
  const done = useRef(false);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    if (!save || name.trim() === property.name) return onDone();
    const err = checkPropertyName(name, others, property.id);
    if (err) return onDone(err);
    // mutateAsync：onDone() 之後此輸入框即卸載，mutate 的呼叫層 onError 不會再執行
    update.mutateAsync({ id: property.id, name: name.trim() }).catch((e) => onDone(e.message));
    onDone();
  };
  return createElement(Input, {
    size: 'sm',
    autoFocus: true,
    value: name,
    'aria-label': '欄位名稱',
    onFocus: (e) => e.currentTarget.select(),
    onChange: (e) => setName(e.target.value),
    onBlur: () => finish(true),
    onKeyDown: (e) => {
      e.stopPropagation();
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    },
  });
}

function ColumnMenu({ col, anchor, onClose, onSort, onHide, onRename, onEditOptions, onDelete }) {
  const isSelect = col.kind === 'select' || col.kind === 'multi_select';
  const items = [
    { key: 'asc', label: '升冪排序', run: () => onSort('asc') },
    { key: 'desc', label: '降冪排序', run: () => onSort('desc') },
  ];
  if (col.property) {
    items.push({ key: 's1', sep: true }, { key: 'rename', label: '重新命名', run: onRename });
    if (isSelect) items.push({ key: 'options', label: '編輯選項', run: onEditOptions });
  }
  if (col.hideable) items.push({ key: 's2', sep: true }, { key: 'hide', label: '隱藏欄位', run: onHide });
  if (col.property) items.push({ key: 'delete', label: '刪除欄位', run: onDelete, danger: true });
  const actionable = items.filter((i) => 'run' in i);
  const [idx, setIdx] = useState(0);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  const pick = (run) => {
    onClose();
    run();
  };
  return createElement(
    Popover,
    {
      anchor: anchor,
      onClose: (reason) => {
        onClose();
        if (reason === 'escape') anchor.focus();
      },
      width: 180,
      role: 'presentation',
    },
    createElement(
      'div',
      {
        ref: ref,
        role: 'menu',
        'aria-label': `${col.label} 欄位選單`,
        tabIndex: -1,
        style: { outline: 'none' },
        onKeyDown: (e) => {
          const n = actionable.length;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((idx + 1) % n);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((idx - 1 + n) % n);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick(actionable[idx].run);
          } else if (e.key === 'Tab') onClose();
        },
      },
      items.map((it) =>
        'sep' in it
          ? createElement('div', { key: it.key, className: 'ui-menu-separator', role: 'separator' })
          : createElement(
              'div',
              {
                key: it.key,
                role: 'menuitem',
                className: `ui-option${it.danger ? ' ui-option--danger' : ''}`,
                'data-highlighted': actionable.indexOf(it) === idx,
                onPointerMove: () => setIdx(actionable.indexOf(it)),
                onClick: () => pick(it.run),
              },
              createElement('span', { className: 'ui-option-label' }, it.label),
            ),
      ),
    ),
  );
}

function GroupLabel({ group }) {
  const users = useUsersById();
  const projects = useProjectsById();
  if (group.mode === 'status') return createElement(StatusBadge, { statusId: group.id });
  if (group.mode === 'assignee')
    return createElement(
      'span',
      { className: 'tl-person' },
      createElement(Avatar, { userId: group.id, size: 'xs', tooltip: false }),
      createElement('span', null, group.id == null ? '未指派' : (users.get(group.id)?.displayName ?? '—')),
    );
  if (group.mode === 'project') {
    const p = group.id != null ? projects.get(group.id) : undefined;
    return createElement(
      'span',
      { className: 'tl-person' },
      createElement(ColorDot, { color: p?.color, size: 'md' }),
      createElement('span', null, p?.name ?? '—'),
    );
  }
  return null;
}

function groupName(group, names) {
  if (group.mode === 'status') return names.status ?? '';
  if (group.mode === 'assignee') return group.id == null ? '未指派' : (names.user ?? '');
  return names.project ?? '';
}

function GroupRow({ group, collapsed, onToggle, cellProps }) {
  const statuses = useStatusesById();
  const users = useUsersById();
  const projects = useProjectsById();
  const canManageStatuses = useCan('statuses.manage');
  const name = groupName(group, {
    status: group.id != null ? statuses.get(group.id)?.name : undefined,
    user: group.id != null ? users.get(group.id)?.displayName : undefined,
    project: group.id != null ? projects.get(group.id)?.name : undefined,
  });
  return createElement(
    'div',
    { role: 'row', className: 'tl-row tl-row--group', 'aria-expanded': !collapsed },
    createElement(ListGroupDnd, { group: group, collapsed: collapsed, onExpand: onToggle }),
    createElement(
      'div',
      {
        role: 'gridcell',
        className: 'tl-group-cell',
        'aria-label': `${name}，${group.tasks.length} 筆，${collapsed ? '已收合' : '已展開'}`,
        ...cellProps,
        onClick: onToggle,
      },
      createElement(Icon, { name: collapsed ? 'chevronRight' : 'chevronDown' }),
      createElement(GroupLabel, { group: group }),
      createElement(Badge, { count: true }, group.tasks.length),
    ),
    group.mode === 'status' &&
      canManageStatuses &&
      createElement(
        'div',
        { role: 'gridcell', className: 'tl-group-add' },
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: 'plus',
            tabIndex: -1,
            onClick: () => openAdminDialog({ kind: 'add-status' }),
          },
          '新增狀態',
        ),
      ),
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
}) {
  const statusMap = useStatusesById();
  const status = statusMap.get(task.statusId);
  const done = status?.category === 'done';
  const temp = task.id < 0;
  // 純顯示：標題左側狀態點的顏色（ui-refresh §3.2）
  const commit = useFieldCommit();
  const toggleDone = async () => {
    const next = toggleDoneStatus(statuses, task.statusId);
    if (next == null) return;
    const col = columns.find((c) => c.key === 'status') ?? {
      key: 'status',
      kind: 'status',
      label: '狀態',
    };
    const r = await commit(task, col, next);
    onSaved(col, r);
  };
  return createElement(
    'div',
    {
      role: 'row',
      className: 'tl-row tl-row--task',
      'data-selected': selected || undefined,
      'data-done': done || undefined,
      'data-due': dueBucket(task.dueDate, done) || undefined,
      ...fxAttr(fx),
      'data-temp': temp || undefined,
      'data-task-id': task.id,
    },
    createElement(
      'div',
      { role: 'gridcell', className: 'tl-cell tl-cell--check tl-sticky-0' },
      createElement(ListRowDnd, { task: task, groupKey: groupKey, navProps: cellProps(rowKey, -1) }),
      createElement(
        'button',
        {
          type: 'button',
          className: 'tl-done',
          'aria-label': '標記為完成',
          'aria-pressed': done,
          disabled: temp,
          ...cellProps(rowKey, 0),
          onClick: () => void toggleDone(),
        },
        done && createElement(Icon, { name: 'check', size: 12, strokeWidth: 2.5 }),
      ),
    ),
    columns.map((c, i) =>
      createElement(TaskCell, {
        key: c.key,
        task: task,
        col: c,
        colIndex: i + 1,
        rowKey: rowKey,
        edit: editing?.col === i + 1 ? { initialText: editing.initialText } : null,
        setEditing: setEditing,
        cellProps: cellProps,
        onSaved: onSaved,
      }),
    ),
    createElement('div', { role: 'gridcell', className: 'tl-cell tl-cell--pad' }),
  );
}

function TaskCell({ task, col, colIndex, rowKey, edit, setEditing, cellProps, onSaved }) {
  const valueText = useValueText(task, col);
  const sticky = col.kind === 'title' ? ' tl-sticky-1' : '';
  if (!isApplicable(task, col))
    return createElement(
      'div',
      {
        role: 'gridcell',
        className: 'tl-cell tl-cell--na',
        title: '此欄位不適用於該專案',
        'aria-label': `${col.label}：不適用`,
      },
      null,
    );
  const extra =
    col.kind === 'title'
      ? task.id < 0
        ? createElement(
            'span',
            { className: 'tl-row-actions tl-row-actions--show' },
            createElement(Spinner, { size: 14 }),
          )
        : createElement(
            'span',
            { className: 'tl-row-actions tl-stop' },
            createElement(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                tabIndex: -1,
                onClick: (e) => {
                  e.stopPropagation();
                  openTask(task.id);
                },
              },
              '開啟',
            ),
            createElement(PinButton, { taskId: task.id, size: 'sm' }),
          )
      : null;
  return createElement(
    'div',
    {
      role: 'gridcell',
      className: `tl-cell${sticky}${col.kind === 'title' ? ' tl-cell--title' : ''}${col.kind === 'dueDate' ? ' tl-cell--due' : ''}`,
      title: col.kind === 'title' ? task.title : undefined,
    },
    createElement(EditableField, {
      task: task,
      col: col,
      mode: 'cell',
      edit: edit,
      onEditChange: (next, move) => setEditing(colIndex, next, move),
      onSaved: (_c, r) => onSaved(col, r),
      'aria-label': `${col.label}：${valueText}`,
      className: col.kind === 'estimate' || col.kind === 'number' ? 'tl-right' : '',
      ...cellProps(rowKey, colIndex),
    }),
    col.kind === 'title' && task.id > 0 && createElement(TitleBadges, { task: task }),
    extra,
  );
}
