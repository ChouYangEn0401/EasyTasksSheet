import { createElement, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/compat';
import { TAG_COLORS } from '../../shared/projects.js';
import { PROPERTY_TYPES } from '../../shared/properties.js';
import { errorMessage } from '../../lib/api.js';
import { useProjectsById, useProperties } from '../../lib/hooks.js';
import { Alert, Button, ColorDot, Dialog, Field, Input, Select } from '../../ui/index.js';
import { useCreateProperty, useDeleteProperty, useUpdateProperty } from './data.js';
import {
  checkOptions,
  checkPropertyName,
  countOptionUsage,
  newOptionId,
  nextOptionColor,
  PROPERTY_TYPE_LABELS,
} from './model.js';
import { Popover } from './Popover.js';

const TYPE_GLYPH = {
  text: 'T',
  number: '#',
  select: '◉',
  multi_select: '≡',
  date: '▦',
  checkbox: '☑',
  url: '↗',
  person: '@',
};

export function TypeIcon({ type }) {
  return createElement('span', { className: 'tl-type-icon', 'aria-hidden': 'true' }, TYPE_GLYPH[type]);
}

const isSelectType = (t) => t === 'select' || t === 'multi_select';

/** 選項編輯區：色點（8 色調色盤）+ 名稱 + 刪除；Enter 新增下一列 */
function OptionsEditor({ options, onChange }) {
  const [palette, setPalette] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector(`[data-opt="${focusId}"]`)?.focus();
  }, [focusId]);

  const add = () => {
    const id = newOptionId(options);
    onChange([...options, { id, label: '', color: nextOptionColor(options.length) }]);
    setFocusId(id);
  };
  const patch = (id, p) => onChange(options.map((o) => (o.id === id ? { ...o, ...p } : o)));

  return createElement(
    'div',
    { className: 'tl-options', ref: listRef },
    options.map((o, i) =>
      createElement(
        'div',
        { key: o.id, className: 'tl-option-row' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'tl-color-btn',
            'aria-label': `選項 ${i + 1} 顏色`,
            onClick: (e) => setPalette({ id: o.id, el: e.currentTarget }),
          },
          createElement(ColorDot, { color: o.color, size: 'md' }),
        ),
        createElement(Input, {
          size: 'sm',
          value: o.label,
          'aria-label': `選項 ${i + 1}`,
          placeholder: `選項${i + 1}`,
          'data-opt': o.id,
          onChange: (e) => patch(o.id, { label: e.target.value }),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          },
        }),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          'aria-label': `刪除選項 ${i + 1}`,
          onClick: () => onChange(options.filter((x) => x.id !== o.id)),
        }),
      ),
    ),
    createElement(Button, { variant: 'ghost', size: 'sm', icon: 'plus', onClick: add }, '新增選項'),
    palette &&
      createElement(
        Popover,
        { anchor: palette.el, onClose: () => setPalette(null), label: '選擇顏色' },
        createElement(
          'div',
          { className: 'tl-palette' },
          TAG_COLORS.map((c) =>
            createElement(
              'button',
              {
                key: c,
                type: 'button',
                className: 'tl-palette-btn',
                'aria-label': c,
                onClick: () => {
                  patch(palette.id, { color: c });
                  setPalette(null);
                },
              },
              createElement(ColorDot, { color: c, size: 'md' }),
            ),
          ),
        ),
      ),
  );
}

/** 被刪除但仍有任務使用的選項 → 警示 */
function RemovedWarnings({ before, after, usage }) {
  const removed = before.filter((o) => !after.some((a) => a.id === o.id));
  const warn = removed.map((o) => ({ o, n: usage(o.id) })).filter((x) => x.n > 0);
  if (!warn.length) return null;
  return createElement(
    'div',
    { className: 'tl-warn-list' },
    warn.map(({ o, n }) =>
      createElement(
        Alert,
        { key: o.id, tone: 'warning' },
        '「',
        o.label,
        '」',
        n,
        ' 筆任務使用中，刪除後這些值會被清除',
      ),
    ),
  );
}

const toDraft = (opts) => opts.map((o, i) => ({ ...o, color: o.color ?? nextOptionColor(i - 1) }));
const cleanOptions = (opts) =>
  opts.filter((o) => o.label.trim()).map((o) => ({ ...o, label: o.label.trim() }));

/** §6.1 新增欄位面板內容 */
export function NewPropertyForm({ scopeProjectId, onDone }) {
  const properties = useProperties().data ?? [];
  const projects = useProjectsById();
  const create = useCreateProperty();
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [options, setOptions] = useState([{ id: 'o1', label: '', color: nextOptionColor(0) }]);
  const [scope, setScope] = useState('all');
  const [touched, setTouched] = useState(false);
  const nameRef = useRef(null);
  useEffect(() => nameRef.current?.focus(), []);

  const nameError = checkPropertyName(name, properties);
  const optError = isSelectType(type) ? checkOptions(options) : null;
  const canSubmit = !nameError && !optError && !create.isPending;
  const project = scopeProjectId != null ? projects.get(scopeProjectId) : undefined;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        name: name.trim(),
        type,
        options: isSelectType(type) ? cleanOptions(options) : undefined,
        projectId: scope === 'project' && scopeProjectId != null ? scopeProjectId : null,
      },
      { onSuccess: (p) => onDone(p) },
    );
  };

  return createElement(
    'form',
    {
      className: 'tl-prop-form',
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    createElement('div', { className: 'tl-prop-title' }, '新增欄位'),
    create.isError && createElement(Alert, { tone: 'danger' }, errorMessage(create.error)),
    createElement(
      Field,
      { label: '名稱', error: touched && name.trim() && nameError ? nameError : undefined },
      createElement(Input, {
        ref: nameRef,
        size: 'sm',
        value: name,
        onChange: (e) => {
          setName(e.target.value);
          setTouched(true);
        },
      }),
    ),
    createElement(
      Field,
      { label: '型別' },
      createElement(Select, {
        'aria-label': '型別',
        value: type,
        onChange: setType,
        options: PROPERTY_TYPES.map((t) => ({
          value: t,
          label: PROPERTY_TYPE_LABELS[t],
          leading: createElement(TypeIcon, { type: t }),
        })),
      }),
    ),
    isSelectType(type) &&
      createElement(
        'div',
        { className: 'ui-field' },
        createElement('span', { className: 'ui-label' }, '選項'),
        createElement(OptionsEditor, { options: options, onChange: setOptions }),
      ),
    createElement(
      'fieldset',
      { className: 'tl-scope' },
      createElement('legend', { className: 'ui-label' }, '範圍'),
      createElement(
        'label',
        { className: 'ui-checkbox-label' },
        createElement('input', {
          type: 'radio',
          name: 'scope',
          checked: scope === 'all',
          onChange: () => setScope('all'),
        }),
        '所有專案',
      ),
      createElement(
        'label',
        { className: 'ui-checkbox-label', 'aria-disabled': !project || undefined },
        createElement('input', {
          type: 'radio',
          name: 'scope',
          disabled: !project,
          checked: scope === 'project',
          onChange: () => setScope('project'),
        }),
        project ? `僅「${project.name}」` : '僅此專案',
      ),
      !project && createElement('span', { className: 'ui-hint' }, '先篩選單一專案'),
    ),
    createElement(
      'div',
      { className: 'tl-prop-actions' },
      createElement(Button, { variant: 'secondary', size: 'sm', onClick: () => onDone() }, '取消'),
      createElement(
        Button,
        { variant: 'primary', size: 'sm', type: 'submit', disabled: !canSubmit, loading: create.isPending },
        '建立',
      ),
    ),
  );
}

/** §6.2 編輯選項（Popover 內容） */
export function EditOptionsForm({ property, tasks, onDone }) {
  const update = useUpdateProperty();
  const [options, setOptions] = useState(() => toDraft(property.options));
  const error = checkOptions(options);
  const usage = (id) => countOptionUsage(tasks, property.id, id);
  return createElement(
    'form',
    {
      className: 'tl-prop-form',
      onSubmit: (e) => {
        e.preventDefault();
        if (error) return;
        update.mutate({ id: property.id, options: cleanOptions(options) }, { onSuccess: onDone });
      },
    },
    createElement('div', { className: 'tl-prop-title' }, '編輯選項：', property.name),
    update.isError && createElement(Alert, { tone: 'danger' }, errorMessage(update.error)),
    createElement(OptionsEditor, { options: options, onChange: setOptions }),
    createElement(RemovedWarnings, { before: property.options, after: options, usage: usage }),
    error && createElement('span', { className: 'ui-field-error' }, error),
    createElement(
      'div',
      { className: 'tl-prop-actions' },
      createElement(Button, { variant: 'secondary', size: 'sm', onClick: onDone }, '取消'),
      createElement(
        Button,
        { variant: 'primary', size: 'sm', type: 'submit', disabled: !!error, loading: update.isPending },
        '儲存',
      ),
    ),
  );
}

/** §6.2 刪除欄位確認 */
export function DeletePropertyDialog({ property, onClose }) {
  const del = useDeleteProperty();
  return createElement(
    Dialog,
    {
      open: !!property,
      onClose: onClose,
      role: 'alertdialog',
      title: `刪除欄位「${property?.name ?? ''}」？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose, 'data-autofocus': true }, '取消'),
        createElement(
          Button,
          {
            variant: 'danger',
            loading: del.isPending,
            onClick: () => property && del.mutate(property.id, { onSuccess: onClose }),
          },
          '刪除欄位',
        ),
      ),
    },
    createElement('p', { className: 'm-0' }, '所有任務在此欄位的值將不再顯示，此動作無法復原。'),
    del.isError &&
      createElement(
        'div',
        { style: { marginTop: 12 } },
        createElement(Alert, { tone: 'danger' }, errorMessage(del.error)),
      ),
  );
}
