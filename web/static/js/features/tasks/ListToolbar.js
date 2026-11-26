import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { useMediaQuery } from '../../lib/storage.js';
import { Button, Checkbox, Select, Tooltip } from '../../ui/index.js';
import { GROUP_MODES } from './model.js';
import { Popover } from './Popover.js';
import { NewPropertyForm, TypeIcon } from './PropertyPanel.js';

/** ViewTabs actions 插槽內容：分組 Select + 欄位 Popover */
export function ListToolbar({
  group,
  onGroup,
  columns,
  hidden,
  onToggleColumn,
  scopeProjectId,
  onPropertyCreated,
}) {
  const compact = !useMediaQuery('(min-width: 1024px)');
  const [anchor, setAnchor] = useState(null);
  const [adding, setAdding] = useState(false);
  const close = () => {
    setAnchor(null);
    setAdding(false);
  };
  const groupLabel = GROUP_MODES.find((g) => g.value === group)?.label ?? '';

  return createElement(
    Fragment,
    null,
    createElement(
      Tooltip,
      { content: compact ? `分組：${groupLabel}` : undefined },
      createElement(Select, {
        'aria-label': '分組',
        className: 'tl-group-select',
        value: group,
        onChange: onGroup,
        align: 'end',
        options: GROUP_MODES,
        renderValue: (o) =>
          createElement(
            'span',
            { className: 'ui-select-label', style: { flex: 1, textAlign: 'left' } },
            compact ? '分組' : `分組：${o?.label ?? ''}`,
          ),
      }),
    ),
    createElement(
      Tooltip,
      { content: compact ? '欄位' : undefined },
      createElement(
        Button,
        {
          variant: 'secondary',
          size: 'sm',
          icon: 'eye',
          iconOnly: compact,
          'aria-label': '欄位',
          'aria-haspopup': 'dialog',
          'aria-expanded': !!anchor,
          onClick: (e) => (anchor ? close() : setAnchor(e.currentTarget)),
        },
        '欄位',
      ),
    ),
    anchor &&
      createElement(
        Popover,
        { anchor: anchor, onClose: close, width: adding ? 300 : 260, label: adding ? '新增欄位' : '欄位' },
        adding
          ? createElement(NewPropertyForm, {
              scopeProjectId: scopeProjectId,
              onDone: (p) => {
                close();
                if (p) onPropertyCreated(p);
              },
            })
          : createElement(
              'div',
              { className: 'tl-columns' },
              columns.map((c) =>
                createElement(
                  'label',
                  { key: c.key, className: 'ui-option tl-column-item' },
                  createElement(Checkbox, {
                    checked: !c.hideable || !hidden.includes(c.key),
                    disabled: !c.hideable,
                    onChange: (e) => onToggleColumn(c.key, e.target.checked),
                  }),
                  c.property
                    ? createElement(TypeIcon, { type: c.property.type })
                    : createElement('span', { className: 'tl-type-icon', 'aria-hidden': 'true' }),
                  createElement('span', { className: 'ui-option-label' }, c.label),
                ),
              ),
              createElement('div', { className: 'ui-menu-separator' }),
              createElement(
                'button',
                { type: 'button', className: 'ui-option', onClick: () => setAdding(true) },
                createElement('span', { className: 'tl-type-icon', 'aria-hidden': 'true' }, '+'),
                createElement('span', { className: 'ui-option-label' }, '新增欄位'),
              ),
            ),
      ),
  );
}
