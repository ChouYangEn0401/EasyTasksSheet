import { createElement, Fragment } from 'preact';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'preact/compat';
import { Checkbox } from './Checkbox.js';
import { Icon } from './Icon.js';

const SEARCH_THRESHOLD = 8;

/** 點外面關閉 */
function useDismiss(open, anchor, close) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (anchor.current && !anchor.current.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, anchor, close]);
}

function Listbox({ id, options, isSelected, onPick, onClose, multiple, label, align, footer }) {
  const [query, setQuery] = useState('');
  const searchable = options.length > SEARCH_THRESHOLD;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const [active, setActive] = useState(() => {
    const i = options.findIndex((o) => isSelected(o.value));
    return i >= 0 ? i : 0;
  });
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const activeIdx = Math.min(active, shown.length - 1);

  useEffect(() => {
    (searchable ? searchRef.current : listRef.current)?.focus();
  }, [searchable]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const move = (delta) => {
    if (!shown.length) return;
    if (delta === 'first') return setActive(0);
    if (delta === 'last') return setActive(shown.length - 1);
    setActive((i) => (Math.min(i, shown.length - 1) + delta + shown.length) % shown.length);
  };

  const pick = (o) => {
    if (!o || o.disabled) return;
    onPick(o.value);
    if (!multiple) onClose(true);
  };

  const onKeyDown = (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return move(1);
      case 'ArrowUp':
        e.preventDefault();
        return move(-1);
      case 'Home':
        if (e.target === searchRef.current) return;
        e.preventDefault();
        return move('first');
      case 'End':
        if (e.target === searchRef.current) return;
        e.preventDefault();
        return move('last');
      case 'Enter':
        e.preventDefault();
        return pick(shown[activeIdx]);
      case ' ':
        if (e.target === searchRef.current) return;
        e.preventDefault();
        return pick(shown[activeIdx]);
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        return onClose(true);
      case 'Tab':
        return onClose(false);
      default:
        // 直接輸入文字跳至相符選項（無搜尋框時）
        if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const k = e.key.toLowerCase();
          const start = activeIdx + 1;
          for (let n = 0; n < shown.length; n++) {
            const i = (start + n) % shown.length;
            if (shown[i].label.toLowerCase().startsWith(k)) {
              setActive(i);
              break;
            }
          }
        }
    }
  };

  return createElement(
    'div',
    { className: `ui-panel${align === 'end' ? ' ui-panel--right' : ''}`, onKeyDown: onKeyDown },
    searchable &&
      createElement(
        'div',
        { className: 'ui-panel-search' },
        createElement('input', {
          ref: searchRef,
          className: 'ui-input ui-input--sm',
          placeholder: '搜尋…',
          value: query,
          onChange: (e) => {
            setQuery(e.target.value);
            setActive(0);
          },
          'aria-controls': id,
          'aria-activedescendant': shown.length ? `${id}-opt-${activeIdx}` : undefined,
          'aria-label': '搜尋選項',
        }),
      ),
    createElement(
      'div',
      {
        ref: listRef,
        id: id,
        role: 'listbox',
        'aria-label': label,
        'aria-multiselectable': multiple || undefined,
        'aria-activedescendant': shown.length ? `${id}-opt-${activeIdx}` : undefined,
        tabIndex: -1,
        className: 'ui-panel-list',
        style: { outline: 'none' },
      },
      shown.length === 0 && createElement('div', { className: 'ui-panel-empty' }, '沒有符合的項目'),
      shown.map((o, i) => {
        const selected = isSelected(o.value);
        return createElement(
          'div',
          {
            key: `${String(o.value)}`,
            id: `${id}-opt-${i}`,
            'data-index': i,
            role: 'option',
            'aria-selected': selected,
            'aria-disabled': o.disabled || undefined,
            'data-highlighted': i === activeIdx,
            className: 'ui-option',
            onPointerMove: () => setActive(i),
            onClick: () => pick(o),
          },
          multiple &&
            createElement(Checkbox, {
              checked: selected,
              readOnly: true,
              tabIndex: -1,
              'aria-hidden': 'true',
            }),
          o.leading,
          createElement('span', { className: 'ui-option-label' }, o.label),
          !multiple && selected && createElement(Icon, { name: 'check', className: 'ui-option-check' }),
        );
      }),
    ),
    footer &&
      createElement(
        'div',
        {
          className: 'ui-panel-footer',
          onKeyDown: (e) => {
            // 底部按鈕自行處理 Enter / Space / 方向鍵；Esc 仍交給面板關閉
            if (e.key !== 'Escape') e.stopPropagation();
          },
        },
        footer(() => onClose(false)),
      ),
  );
}

function usePopoverState() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const triggerRef = useRef(null);
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(open, anchorRef, dismiss);
  return { open, setOpen, anchorRef, triggerRef, close };
}

function triggerKeyDown(setOpen) {
  return (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };
}

/** 單選下拉 */
export function Select({ options, value, onChange, placeholder = '請選擇', renderValue, ...trigger }) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  const listId = useId();
  const current = options.find((o) => o.value === value);
  return createElement(
    'span',
    { ref: anchorRef, className: `ui-popover-anchor ${trigger.className ?? ''}` },
    createElement(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        id: trigger.id,
        className: 'ui-select-trigger',
        style: { width: '100%', fontWeight: 'var(--font-regular)' },
        'data-active': trigger.active || undefined,
        disabled: trigger.disabled,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': open ? listId : undefined,
        'aria-label': trigger['aria-label'],
        'aria-describedby': trigger['aria-describedby'],
        'aria-invalid': trigger.invalid || undefined,
        onClick: () => setOpen(!open),
        onKeyDown: triggerKeyDown(setOpen),
      },
      renderValue
        ? renderValue(current)
        : createElement(
            Fragment,
            null,
            current?.leading,
            createElement(
              'span',
              {
                className: 'ui-select-label',
                style: {
                  flex: 1,
                  textAlign: 'left',
                  color: current ? undefined : 'var(--color-text-tertiary)',
                },
              },
              current?.label ?? placeholder,
            ),
          ),
      createElement(Icon, { name: 'chevronDown', className: 'ui-select-chevron' }),
    ),
    open &&
      createElement(Listbox, {
        id: listId,
        options: options,
        isSelected: (v) => v === value,
        onPick: onChange,
        onClose: close,
        label: trigger['aria-label'],
        align: trigger.align,
        footer: trigger.footer,
      }),
  );
}

/**
 * 多選下拉（FilterBar 用）。觸發鈕：未設定顯示 label；已設定為 accent-soft 樣式，
 * 文字為「label：第一項」，多個時加「 +N」。
 */
export function MultiSelect({ label, options, value, onChange, ...trigger }) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  const listId = useId();
  const selected = options.filter((o) => value.includes(o.value));
  const active = trigger.active ?? value.length > 0;
  const text =
    value.length === 0
      ? label
      : `${label}：${selected[0]?.label ?? value.length}${value.length > 1 ? ` +${value.length - 1}` : ''}`;
  return createElement(
    'span',
    { ref: anchorRef, className: `ui-popover-anchor ${trigger.className ?? ''}` },
    createElement(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        id: trigger.id,
        className: 'ui-select-trigger',
        'data-active': active || undefined,
        disabled: trigger.disabled,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': open ? listId : undefined,
        'aria-label': trigger['aria-label'],
        onClick: () => setOpen(!open),
        onKeyDown: triggerKeyDown(setOpen),
      },
      createElement('span', { className: 'ui-select-label' }, text),
      createElement(Icon, { name: 'chevronDown', className: 'ui-select-chevron' }),
    ),
    open &&
      createElement(Listbox, {
        id: listId,
        options: options,
        multiple: true,
        isSelected: (v) => value.includes(v),
        onPick: (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]),
        onClose: close,
        label: label,
        align: trigger.align,
        footer: trigger.footer,
      }),
  );
}

/**
 * 動作選單：trigger 為 render function，收到要展開在按鈕上的 props。
 * items 可含分隔線（separator）與不可點的自訂內容（content）。
 */
export function Menu({ trigger, items, align = 'start', width, label }) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  // 可移動到的項目（含停用項目，讓鍵盤使用者也能得知停用原因）
  const actionable = items.filter((i) => 'onSelect' in i);
  const [active, setActive] = useState(0);
  const menuRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);
  const openMenu = (v) => {
    if (v)
      setActive(
        Math.max(
          0,
          actionable.findIndex((i) => !i.disabled),
        ),
      );
    setOpen(v);
  };

  const onKeyDown = (e) => {
    const n = actionable.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return n && setActive((i) => (i + 1) % n);
      case 'ArrowUp':
        e.preventDefault();
        return n && setActive((i) => (i - 1 + n) % n);
      case 'Home':
        e.preventDefault();
        return setActive(0);
      case 'End':
        e.preventDefault();
        return setActive(Math.max(0, n - 1));
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = actionable[active];
        if (item && !item.disabled) {
          close(true);
          item.onSelect();
        }
        return;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        return close(true);
      case 'Tab':
        return close(false);
    }
  };

  return createElement(
    'span',
    { ref: anchorRef, className: 'ui-popover-anchor' },
    trigger({
      ref: triggerRef,
      onClick: () => openMenu(!open),
      onKeyDown: triggerKeyDown(openMenu),
      'aria-haspopup': 'menu',
      'aria-expanded': open,
    }),
    open &&
      createElement(
        'div',
        {
          ref: menuRef,
          role: 'menu',
          'aria-label': label,
          'aria-activedescendant': actionable[active] ? `${menuId}-item-${active}` : undefined,
          tabIndex: -1,
          className: `ui-panel${align === 'end' ? ' ui-panel--right' : ''}`,
          style: { width, outline: 'none' },
          onKeyDown: onKeyDown,
        },
        items.map((item) => {
          if ('separator' in item)
            return createElement('div', { key: item.key, className: 'ui-menu-separator', role: 'separator' });
          if ('content' in item)
            return createElement('div', { key: item.key, role: 'presentation' }, item.content);
          const idx = actionable.indexOf(item);
          const highlighted = idx === active && idx >= 0;
          const reason = item.disabled ? item.disabledReason : undefined;
          return createElement(
            'div',
            {
              key: item.key,
              id: `${menuId}-item-${idx}`,
              role: 'menuitem',
              'aria-disabled': item.disabled || undefined,
              'aria-description': reason,
              title: reason,
              'data-highlighted': highlighted,
              className: `ui-option${item.danger ? ' ui-option--danger' : ''}`,
              style: reason && highlighted ? { flexWrap: 'wrap' } : undefined,
              onPointerMove: () => idx >= 0 && setActive(idx),
              onClick: () => {
                if (item.disabled) return;
                close(false);
                item.onSelect();
              },
            },
            item.icon,
            createElement('span', { className: 'ui-option-label' }, item.label),
            reason &&
              highlighted &&
              createElement(
                'span',
                {
                  'aria-hidden': 'true',
                  style: {
                    flexBasis: '100%',
                    fontSize: 'var(--text-xs, 12px)',
                    color: 'var(--color-text-tertiary)',
                  },
                },
                reason,
              ),
          );
        }),
      ),
  );
}
