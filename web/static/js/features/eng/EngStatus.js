import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { ENG_CATEGORY_LABELS, ISSUE_CATEGORIES, WORKTREE_CATEGORIES } from '../../shared/engManual.js';
import { TAG_COLORS } from '../../shared/projects.js';
import { errorMessage } from '../../lib/api.js';
import { tagVars } from '../../lib/colors.js';
import { useCan } from '../../lib/permissions.js';
import { notifySuccess } from '../../lib/toast.js';
import { Alert, Badge, Button, ColorDot, Dialog, Field, Icon, Input, Select } from '../../ui/index.js';
import { useCreateEngStatus, useDeleteEngStatus, useUpdateEngStatus } from './api.js';
import { selectableStatuses, statusView } from './model.js';
import { StatusAdminContext, useStatusAdmin, useStatusList } from './statusHooks.js';

const KIND_LABEL = { issue: '問題', worktree: '工作樹' };
const CATEGORIES = {
  issue: ISSUE_CATEGORIES,
  worktree: WORKTREE_CATEGORIES,
};
const CATEGORY_HINT = {
  issue: '「已結案」類預設隱藏，可勾選「顯示已結案」查看',
  worktree: '「已結束」類預設隱藏（可勾選「顯示已清理」），也不會提示回報中找不到',
};

// ── 對話框開關（EngPage 提供） ──

export function StatusAdminProvider({ children }) {
  const [state, setState] = useState(null);
  const [seq, setSeq] = useState(0);
  const canManage = useCan('eng.status.manage');
  const open = (s) => {
    setSeq((n) => n + 1);
    setState(s);
  };
  return createElement(
    StatusAdminContext.Provider,
    { value: open },
    children,
    canManage &&
      state?.mode === 'add' &&
      createElement(AddStatusDialog, {
        key: seq,
        kind: state.kind,
        onCreated: state.onCreated,
        onClose: () => setState(null),
      }),
    canManage &&
      state?.mode === 'manage' &&
      createElement(StatusManagerDialog, { key: seq, kind: state.kind, onClose: () => setState(null) }),
  );
}

/** 管理入口按鈕（工具列用；無權限不顯示） */
export function ManageStatusesButton({ kind }) {
  const canManage = useCan('eng.status.manage');
  const open = useStatusAdmin();
  if (!canManage) return null;
  return createElement(
    Button,
    { variant: 'ghost', size: 'sm', icon: 'pencil', onClick: () => open({ mode: 'manage', kind }) },
    '管理狀態',
  );
}

/** 狀態下拉：由 eng_statuses 驅動；底部「＋ 新增狀態…」「管理狀態…」（需 eng.status.manage） */
export function StatusSelect({ kind, value, onChange, label, badge = false }) {
  const list = useStatusList(kind);
  const canManage = useCan('eng.status.manage');
  const open = useStatusAdmin();
  const current = statusView(list, kind, value);
  const options = selectableStatuses(list, value).map((s) => ({
    value: s.key,
    label: s.isArchived ? `${s.label}（已封存）` : s.label,
    leading: createElement(ColorDot, { color: s.color, size: 'md' }),
  }));
  if (!options.some((o) => o.value === value)) {
    options.push({
      value,
      label: current.label,
      leading: createElement(ColorDot, { color: current.color, size: 'md' }),
    });
  }
  return createElement(Select, {
    options: options,
    value: value,
    onChange: (v) => {
      if (v !== value) onChange(v);
    },
    'aria-label': label,
    renderValue: badge
      ? () => createElement(Badge, { tone: current.color, dot: true }, current.label)
      : undefined,
    footer: canManage
      ? (close) =>
          createElement(
            Fragment,
            null,
            createElement(
              'button',
              {
                type: 'button',
                className: 'ui-option',
                onClick: () => {
                  close();
                  open({ mode: 'add', kind, onCreated: onChange });
                },
              },
              createElement(Icon, { name: 'plus' }),
              createElement('span', { className: 'ui-option-label' }, '新增狀態…'),
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'ui-option',
                onClick: () => {
                  close();
                  open({ mode: 'manage', kind });
                },
              },
              createElement(Icon, { name: 'pencil' }),
              createElement('span', { className: 'ui-option-label' }, '管理狀態…'),
            ),
          )
      : undefined,
  });
}

// ── 色票、類別 ──

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

function CategorySelect({ kind, value, onChange, label }) {
  const options = CATEGORIES[kind].map((c) => ({ value: c, label: ENG_CATEGORY_LABELS[c] }));
  return createElement(Select, { options: options, value: value, onChange: onChange, 'aria-label': label });
}

function nextColor(list) {
  const used = new Set(list.map((s) => s.color));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[list.length % TAG_COLORS.length];
}

// ── 新增狀態 ──

function AddStatusForm({ id, kind, onDone, onCancel, inline = false }) {
  const list = useStatusList(kind);
  const create = useCreateEngStatus();
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(() => nextColor(list));
  const [category, setCategory] = useState(CATEGORIES[kind][0]);
  const trimmed = label.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate({ kind, label: trimmed, color, category }, { onSuccess: onDone });
  };
  return createElement(
    'form',
    {
      id: id,
      className: inline ? 'adm-inline eng-status-add' : 'adm-form',
      'aria-label': `新增${KIND_LABEL[kind]}狀態`,
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    create.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(create.error)),
    createElement(
      Field,
      { label: '狀態名稱' },
      createElement(Input, {
        'data-autofocus': true,
        autoFocus: inline,
        size: inline ? 'sm' : undefined,
        value: label,
        maxLength: 40,
        placeholder: kind === 'issue' ? '例如：待回覆' : '例如：待驗證',
        onChange: (e) => setLabel(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape' && inline) {
            e.stopPropagation();
            onCancel();
          }
        },
      }),
    ),
    createElement(
      Field,
      { label: '顏色' },
      createElement(ColorPicker, { value: color, onChange: setColor, label: '狀態顏色' }),
    ),
    createElement(
      Field,
      { label: '類別', hint: CATEGORY_HINT[kind] },
      createElement(CategorySelect, {
        kind: kind,
        value: category,
        onChange: setCategory,
        label: '狀態類別',
      }),
    ),
    inline
      ? createElement(
          'div',
          { className: 'eng-status-add-actions' },
          createElement(Button, { variant: 'ghost', size: 'sm', onClick: onCancel }, '取消'),
          createElement(
            Button,
            { type: 'submit', variant: 'primary', size: 'sm', disabled: !trimmed, loading: create.isPending },
            '新增',
          ),
        )
      : null,
  );
}

function AddStatusDialog({ kind, onCreated, onClose }) {
  const formId = `eng-add-status-${kind}`;
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      title: `新增${KIND_LABEL[kind]}狀態`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'ghost', onClick: onClose }, '取消'),
        createElement(Button, { variant: 'primary', type: 'submit', form: formId }, '新增'),
      ),
    },
    createElement(AddStatusForm, {
      id: formId,
      kind: kind,
      onCancel: onClose,
      onDone: (s) => {
        notifySuccess(`已新增狀態「${s.label}」`);
        onCreated?.(s.key);
        onClose();
      },
    }),
  );
}

// ── 管理狀態 ──

function StatusManagerDialog({ kind, onClose }) {
  const list = useStatusList(kind);
  const update = useUpdateEngStatus();
  const [adding, setAdding] = useState(false);
  const move = (from, to) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    next.forEach((s, i) => {
      if (s.sortOrder !== i + 1) update.mutate({ id: s.id, sortOrder: i + 1 });
    });
  };
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      title: `管理${KIND_LABEL[kind]}狀態`,
      size: 'md',
      actions: createElement(
        Fragment,
        null,
        createElement(
          Button,
          { variant: 'secondary', icon: 'plus', onClick: () => setAdding(true), disabled: adding },
          '新增狀態',
        ),
        createElement(Button, { variant: 'primary', onClick: onClose }, '完成'),
      ),
    },
    createElement(
      'p',
      { className: 'adm-hint' },
      '內建狀態可改名、改色、排序與封存，但不能刪除；自訂狀態沒有資料使用時可刪除，使用中只能封存。封存的狀態不出現在選單，舊資料仍照常顯示。',
      CATEGORY_HINT[kind],
      '。',
    ),
    createElement(
      'div',
      { className: 'adm-list', 'data-testid': 'eng-status-list' },
      list.map((s, i) =>
        createElement(StatusRow, {
          key: s.id,
          kind: kind,
          status: s,
          index: i,
          last: i === list.length - 1,
          onMove: move,
        }),
      ),
    ),
    adding &&
      createElement(AddStatusForm, {
        inline: true,
        kind: kind,
        onCancel: () => setAdding(false),
        onDone: (s) => {
          notifySuccess(`已新增狀態「${s.label}」`);
          setAdding(false);
        },
      }),
  );
}

function StatusRow({ kind, status, index, last, onMove }) {
  const update = useUpdateEngStatus();
  const del = useDeleteEngStatus();
  const [label, setLabel] = useState(status.label);
  const [seen, setSeen] = useState(status.label);
  if (seen !== status.label) {
    setSeen(status.label);
    setLabel(status.label);
  }
  const commit = () => {
    const t = label.trim();
    if (!t) return setLabel(status.label);
    if (t !== status.label)
      update.mutate({ id: status.id, label: t }, { onError: () => setLabel(status.label) });
  };
  const usage = status.usage ?? 0;
  const canDelete = !status.isBuiltin && usage === 0;
  return createElement(
    'div',
    {
      className: 'adm-row',
      'data-testid': 'eng-status-row',
      'data-archived': status.isArchived || undefined,
    },
    createElement(
      'div',
      { className: 'adm-row-main' },
      createElement(
        'div',
        { className: 'adm-row-top' },
        createElement(Input, {
          size: 'sm',
          'aria-label': `狀態名稱：${status.label}`,
          value: label,
          maxLength: 40,
          onChange: (e) => setLabel(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setLabel(status.label);
            }
          },
        }),
        createElement(
          'span',
          { className: 'adm-usage' },
          status.isBuiltin ? '內建 · ' : '',
          usage > 0 ? `${usage} 筆使用中` : '未使用',
        ),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: createElement(Icon, { name: 'chevronDown', style: { transform: 'rotate(180deg)' } }),
          'aria-label': `上移：${status.label}`,
          disabled: index === 0,
          onClick: () => onMove(index, index - 1),
        }),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'chevronDown',
          'aria-label': `下移：${status.label}`,
          disabled: last,
          onClick: () => onMove(index, index + 1),
        }),
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            'aria-label': `${status.isArchived ? '取消封存' : '封存'}：${status.label}`,
            onClick: () => update.mutate({ id: status.id, isArchived: !status.isArchived }),
          },
          status.isArchived ? '取消封存' : '封存',
        ),
        !status.isBuiltin &&
          createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              'aria-label': `刪除狀態：${status.label}`,
              disabled: !canDelete,
              title: canDelete ? undefined : '使用中的狀態只能封存',
              loading: del.isPending,
              onClick: () =>
                del.mutate(status.id, { onSuccess: () => notifySuccess(`已刪除狀態「${status.label}」`) }),
            },
            '刪除',
          ),
      ),
      createElement(
        'div',
        { className: 'adm-row-bottom' },
        createElement(ColorPicker, {
          value: status.color,
          label: `顏色：${status.label}`,
          onChange: (color) => update.mutate({ id: status.id, color }),
        }),
        status.isBuiltin
          ? createElement('span', { className: 'adm-usage' }, '類別：', ENG_CATEGORY_LABELS[status.category])
          : createElement(CategorySelect, {
              kind: kind,
              value: status.category,
              label: `類別：${status.label}`,
              onChange: (category) => update.mutate({ id: status.id, category }),
            }),
      ),
    ),
  );
}
