import { createElement, Fragment } from 'preact';
import { useMemo, useState } from 'preact/compat';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { STATUS_CATEGORIES, TAG_COLORS } from '../../shared/projects.js';
import { tagVars } from '../../lib/colors.js';
import {
  useCreateProject,
  useCreateStatus,
  useDeleteStatus,
  useProjects,
  useStatuses,
  useStatusUsage,
  useUpdateProject,
  useUpdateStatus,
} from '../../lib/hooks.js';
import { useCan } from '../../lib/permissions.js';
import { notifySuccess } from '../../lib/toast.js';
import { Alert, Button, ColorDot, Dialog, Field, Icon, Input, Select } from '../../ui/index.js';
import { closeAdminDialog, useAdminDialog } from './adminUi.js';
import {
  CATEGORY_HINT,
  CATEGORY_LABELS,
  defaultMigrationTarget,
  migrationTargets,
  moveItem,
  nextFreeColor,
  sortOrderChanges,
} from './statusAdmin.js';

/** 掛在 TaskAreaLayout 的對話框集合；開關見 adminUi.ts。各對話框只在具備對應權限時才掛載 */
export function AdminDialogs() {
  const { dialog, seq } = useAdminDialog();
  const canStatus = useCan('statuses.manage');
  const canCreate = useCan('projects.create');
  const canManage = useCan('projects.manage');
  return createElement(
    Fragment,
    null,
    canStatus && createElement(AddStatusDialog, { key: seq, open: dialog?.kind === 'add-status' }),
    canStatus && createElement(StatusManagerDialog, { key: seq, open: dialog?.kind === 'manage-statuses' }),
    canCreate &&
      createElement(AddProjectDialog, {
        key: seq,
        open: dialog?.kind === 'add-project',
        onCreated: dialog?.kind === 'add-project' ? dialog.onCreated : undefined,
      }),
    canManage && createElement(ProjectManagerDialog, { key: seq, open: dialog?.kind === 'manage-projects' }),
  );
}

/** 八色選擇（TAG_COLORS） */
function ColorPicker({ value, onChange, label }) {
  return createElement(
    'div',
    { className: 'adm-colors', role: 'radiogroup', 'aria-label': label },
    TAG_COLORS.map((c) =>
      createElement(
        'button',
        {
          key: c,
          type: 'button',
          role: 'radio',
          'aria-checked': value === c,
          'aria-label': c,
          title: c,
          className: 'adm-swatch',
          'data-selected': value === c || undefined,
          style: { background: tagVars(c).color },
          onClick: () => onChange(c),
        },
        value === c && createElement(Icon, { name: 'check', size: 12 }),
      ),
    ),
  );
}

const CATEGORY_OPTIONS = STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }));

function CategorySelect({ value, onChange, label }) {
  return createElement(Select, {
    options: CATEGORY_OPTIONS,
    value: value,
    onChange: onChange,
    'aria-label': label,
  });
}

/* ── 新增狀態 ─────────────────────────── */

function AddStatusDialog({ open }) {
  const statuses = useStatuses().data ?? [];
  const create = useCreateStatus();
  // 每次開啟都會以新的 key 重新掛載（見 AdminDialogs），初始值即為預設
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextFreeColor(statuses.map((s) => s.color)));
  const [category, setCategory] = useState('todo');

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate(
      { name: trimmed, color, category },
      {
        onSuccess: (s) => {
          closeAdminDialog();
          notifySuccess(`已新增狀態「${s.name}」`);
        },
      },
    );
  };
  return createElement(
    Dialog,
    {
      open: open,
      onClose: closeAdminDialog,
      title: '新增狀態',
      dirty: !!trimmed,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'ghost', onClick: closeAdminDialog }, '取消'),
        createElement(
          Button,
          { variant: 'primary', disabled: !trimmed, loading: create.isPending, onClick: submit },
          '新增',
        ),
      ),
    },
    createElement(
      'form',
      {
        className: 'adm-form',
        onSubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      createElement(
        Field,
        { label: '狀態名稱' },
        createElement(Input, {
          'data-autofocus': true,
          value: name,
          maxLength: 100,
          placeholder: '例如：待驗收',
          onChange: (e) => setName(e.target.value),
        }),
      ),
      createElement(
        Field,
        { label: '顏色' },
        createElement(ColorPicker, { value: color, onChange: setColor, label: '狀態顏色' }),
      ),
      createElement(
        Field,
        { label: '類別', hint: CATEGORY_HINT },
        createElement(CategorySelect, { value: category, onChange: setCategory, label: '狀態類別' }),
      ),
      createElement('button', { type: 'submit', hidden: true }),
    ),
  );
}

/* ── 管理狀態 ─────────────────────────── */

function StatusManagerDialog({ open }) {
  const statusesQ = useStatuses();
  const usageQ = useStatusUsage(open);
  const update = useUpdateStatus();
  const [order, setOrder] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const server = statusesQ.data;
  const list = order ?? server ?? [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const applyOrder = async (next) => {
    setOrder(next);
    setSaving(true);
    try {
      await Promise.all(sortOrderChanges(next).map((c) => update.mutateAsync(c)));
    } catch {
      /* 全域 toast 已顯示錯誤 */
    } finally {
      setSaving(false);
      setOrder(null);
    }
  };
  const move = (from, to) => void applyOrder(moveItem(list, from, to));
  const onDragEnd = (e) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(
      list.findIndex((s) => s.id === e.active.id),
      list.findIndex((s) => s.id === e.over.id),
    );
  };

  return createElement(
    Dialog,
    {
      open: open,
      onClose: closeAdminDialog,
      title: '管理狀態',
      size: 'md',
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          { variant: 'secondary', icon: 'plus', onClick: () => setAdding(true) },
          '新增狀態',
        ),
        createElement(Button, { variant: 'primary', onClick: closeAdminDialog }, '完成'),
      ),
    },
    createElement(
      'p',
      { className: 'adm-hint' },
      '拖曳或用上下鈕調整順序（清單、看板與篩選同步）。',
      CATEGORY_HINT,
      '。',
    ),
    createElement(
      'div',
      { className: 'adm-list', 'aria-busy': saving || undefined },
      createElement(
        DndContext,
        { sensors: sensors, collisionDetection: closestCenter, onDragEnd: onDragEnd },
        createElement(
          SortableContext,
          { items: list.map((s) => s.id), strategy: verticalListSortingStrategy },
          list.map((s, i) =>
            createElement(StatusRow, {
              key: s.id,
              status: s,
              index: i,
              last: i === list.length - 1,
              usage: usageQ.data?.[String(s.id)] ?? 0,
              onMove: move,
              onRemove: () => setRemoving(s),
            }),
          ),
        ),
      ),
    ),
    removing &&
      createElement(DeleteStatusPanel, {
        key: removing.id,
        status: removing,
        statuses: list,
        usage: usageQ.data?.[String(removing.id)] ?? 0,
        onDone: () => setRemoving(null),
      }),
    adding && createElement(AddStatusInline, { onClose: () => setAdding(false) }),
  );
}

function StatusRow({ status, index, last, usage, onMove, onRemove }) {
  const update = useUpdateStatus();
  const [name, setName] = useState(status.name);
  const [seenName, setSeenName] = useState(status.name);
  if (seenName !== status.name) {
    setSeenName(status.name);
    setName(status.name);
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
  });
  const commitName = () => {
    const t = name.trim();
    if (!t) return setName(status.name);
    if (t !== status.name) update.mutate({ id: status.id, name: t }, { onError: () => setName(status.name) });
  };
  return createElement(
    'div',
    {
      ref: setNodeRef,
      className: 'adm-row',
      'data-testid': 'status-row',
      'data-dragging': isDragging || undefined,
      style: { transform: CSS.Transform.toString(transform), transition },
    },
    createElement(
      'button',
      {
        type: 'button',
        className: 'adm-grip',
        'aria-label': `拖曳排序：${status.name}`,
        ...attributes,
        ...listeners,
      },
      createElement(Icon, { name: 'grip' }),
    ),
    createElement(
      'div',
      { className: 'adm-row-main' },
      createElement(
        'div',
        { className: 'adm-row-top' },
        createElement(Input, {
          size: 'sm',
          'aria-label': `狀態名稱：${status.name}`,
          value: name,
          maxLength: 100,
          onChange: (e) => setName(e.target.value),
          onBlur: commitName,
          onKeyDown: (e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setName(status.name);
            }
          },
        }),
        createElement('span', { className: 'adm-usage' }, usage > 0 ? `${usage} 筆任務` : '未使用'),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: createElement(Icon, { name: 'chevronDown', style: { transform: 'rotate(180deg)' } }),
          'aria-label': `上移：${status.name}`,
          disabled: index === 0,
          onClick: () => onMove(index, index - 1),
        }),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'chevronDown',
          'aria-label': `下移：${status.name}`,
          disabled: last,
          onClick: () => onMove(index, index + 1),
        }),
        createElement(
          Button,
          { variant: 'ghost', size: 'sm', 'aria-label': `刪除狀態：${status.name}`, onClick: onRemove },
          '刪除',
        ),
      ),
      createElement(
        'div',
        { className: 'adm-row-bottom' },
        createElement(ColorPicker, {
          value: status.color,
          label: `顏色：${status.name}`,
          onChange: (color) => update.mutate({ id: status.id, color }),
        }),
        createElement(CategorySelect, {
          value: status.category,
          label: `類別：${status.name}`,
          onChange: (category) => update.mutate({ id: status.id, category }),
        }),
      ),
    ),
  );
}

function AddStatusInline({ onClose }) {
  const statuses = useStatuses().data ?? [];
  const create = useCreateStatus();
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextFreeColor(statuses.map((s) => s.color)));
  const [category, setCategory] = useState('todo');
  const submit = () => {
    const t = name.trim();
    if (!t) return;
    create.mutate({ name: t, color, category }, { onSuccess: onClose });
  };
  return createElement(
    'form',
    {
      className: 'adm-inline',
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    createElement(Input, {
      autoFocus: true,
      size: 'sm',
      'aria-label': '新狀態名稱',
      placeholder: '新狀態名稱',
      value: name,
      maxLength: 100,
      onChange: (e) => setName(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      },
    }),
    createElement(ColorPicker, { value: color, onChange: setColor, label: '新狀態顏色' }),
    createElement(CategorySelect, { value: category, onChange: setCategory, label: '新狀態類別' }),
    createElement(
      Button,
      { type: 'submit', variant: 'primary', size: 'sm', disabled: !name.trim(), loading: create.isPending },
      '新增',
    ),
    createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '取消'),
  );
}

function DeleteStatusPanel({ status, statuses, usage, onDone }) {
  const del = useDeleteStatus();
  const targets = useMemo(() => migrationTargets(statuses, status.id), [statuses, status.id]);
  const [target, setTarget] = useState(() => defaultMigrationTarget(statuses, status));
  const onlyOne = targets.length === 0;
  const confirm = () => {
    del.mutate(
      { id: status.id, targetStatusId: usage > 0 && target != null ? target : undefined },
      {
        onSuccess: () => {
          notifySuccess(`已刪除狀態「${status.name}」`);
          onDone();
        },
      },
    );
  };
  return createElement(
    Alert,
    { tone: usage > 0 ? 'warning' : 'info' },
    createElement(
      'div',
      { className: 'adm-delete', 'data-testid': 'delete-status-panel' },
      createElement('strong', null, '刪除「', status.name, '」'),
      onlyOne
        ? createElement('p', null, '至少需保留一個狀態，無法刪除。')
        : usage > 0
          ? createElement(
              Fragment,
              null,
              createElement(
                'p',
                null,
                '有 ',
                usage,
                ' 筆任務（含已刪除可還原的任務）使用此狀態，請先選擇要改移到哪個狀態。',
              ),
              createElement(
                'div',
                { className: 'adm-delete-target' },
                createElement('span', null, '改移任務到'),
                createElement(Select, {
                  'aria-label': '改移任務到',
                  value: target,
                  onChange: setTarget,
                  options: targets.map((s) => ({
                    value: s.id,
                    label: s.name,
                    leading: createElement(ColorDot, { color: s.color, size: 'md' }),
                  })),
                }),
              ),
            )
          : createElement('p', null, '沒有任務使用此狀態，可直接刪除。'),
      createElement(
        'div',
        { className: 'adm-delete-actions' },
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: onDone }, '取消'),
        !onlyOne &&
          createElement(
            Button,
            {
              variant: 'danger',
              size: 'sm',
              loading: del.isPending,
              disabled: usage > 0 && target == null,
              onClick: confirm,
            },
            usage > 0 ? '改移任務並刪除' : '刪除狀態',
          ),
      ),
    ),
  );
}

/* ── 新增專案 ─────────────────────────── */

function AddProjectDialog({ open, onCreated }) {
  const projects = useProjects().data ?? [];
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextFreeColor(projects.map((p) => p.color)));
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate(
      { name: trimmed, color },
      {
        onSuccess: (p) => {
          closeAdminDialog();
          onCreated?.(p);
          notifySuccess(`已新增專案「${p.name}」`);
        },
      },
    );
  };
  return createElement(
    Dialog,
    {
      open: open,
      onClose: closeAdminDialog,
      title: '新增專案',
      dirty: !!trimmed,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'ghost', onClick: closeAdminDialog }, '取消'),
        createElement(
          Button,
          { variant: 'primary', disabled: !trimmed, loading: create.isPending, onClick: submit },
          '新增專案',
        ),
      ),
    },
    createElement(
      'form',
      {
        className: 'adm-form',
        onSubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      createElement(
        Field,
        { label: '專案名稱' },
        createElement(Input, {
          'data-autofocus': true,
          value: name,
          maxLength: 100,
          placeholder: '輸入名稱後按 Enter',
          onChange: (e) => setName(e.target.value),
        }),
      ),
      createElement(
        Field,
        { label: '顏色' },
        createElement(ColorPicker, { value: color, onChange: setColor, label: '專案顏色' }),
      ),
      createElement('button', { type: 'submit', hidden: true }),
    ),
  );
}

/* ── 管理專案（改名 / 改色 / 封存；需 projects.manage）── */

function ProjectManagerDialog({ open }) {
  const projects = useProjects().data ?? [];
  const [showArchived, setShowArchived] = useState(false);
  const shown = projects.filter((p) => showArchived || !p.isArchived);
  const archivedCount = projects.filter((p) => p.isArchived).length;
  return createElement(
    Dialog,
    {
      open: open,
      onClose: closeAdminDialog,
      title: '管理專案',
      size: 'md',
      actions: createElement(Button, { variant: 'primary', onClick: closeAdminDialog }, '完成'),
    },
    createElement(
      'p',
      { className: 'adm-hint' },
      '預設專案不可刪除，只能改名或封存；封存的專案不會出現在下拉選單。',
    ),
    createElement(
      'div',
      { className: 'adm-list' },
      shown.map((p) => createElement(ProjectRow, { key: p.id, project: p })),
    ),
    archivedCount > 0 &&
      createElement(
        'label',
        { className: 'adm-check' },
        createElement('input', {
          type: 'checkbox',
          checked: showArchived,
          onChange: (e) => setShowArchived(e.target.checked),
        }),
        '顯示已封存（',
        archivedCount,
        '）',
      ),
  );
}

function ProjectRow({ project }) {
  const update = useUpdateProject();
  const [name, setName] = useState(project.name);
  const [seenName, setSeenName] = useState(project.name);
  if (seenName !== project.name) {
    setSeenName(project.name);
    setName(project.name);
  }
  const commitName = () => {
    const t = name.trim();
    if (!t) return setName(project.name);
    if (t !== project.name)
      update.mutate({ id: project.id, name: t }, { onError: () => setName(project.name) });
  };
  return createElement(
    'div',
    { className: 'adm-row', 'data-testid': 'project-row', 'data-archived': project.isArchived || undefined },
    createElement(
      'div',
      { className: 'adm-row-main' },
      createElement(
        'div',
        { className: 'adm-row-top' },
        createElement(Input, {
          size: 'sm',
          'aria-label': `專案名稱：${project.name}`,
          value: name,
          maxLength: 100,
          onChange: (e) => setName(e.target.value),
          onBlur: commitName,
          onKeyDown: (e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setName(project.name);
            }
          },
        }),
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            'aria-label': `${project.isArchived ? '取消封存' : '封存'}：${project.name}`,
            onClick: () => update.mutate({ id: project.id, isArchived: !project.isArchived }),
          },
          project.isArchived ? '取消封存' : '封存',
        ),
      ),
      createElement(ColorPicker, {
        value: project.color,
        label: `顏色：${project.name}`,
        onChange: (color) => update.mutate({ id: project.id, color }),
      }),
    ),
  );
}
