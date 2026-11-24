import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Checkbox } from './Checkbox.tsx';
import { Icon } from './Icon.tsx';

/*
 * Select（單選）、MultiSelect（多選）、Menu（動作選單）共用同一種面板樣式與鍵盤操作：
 * ↑ ↓ Home End 移動、Enter / Space 選取、直接輸入文字跳至相符選項、Esc 關閉並把 focus 還給觸發鈕。
 * 超過 8 個選項時面板頂部出現搜尋框。
 */

export type SelectOption<T> = {
  value: T;
  label: string;
  /** 選項前置內容（色點、Avatar…） */
  leading?: ReactNode;
  disabled?: boolean;
};

const SEARCH_THRESHOLD = 8;

/** 點外面關閉 */
function useDismiss(open: boolean, anchor: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, anchor, close]);
}

type ListboxProps<T> = {
  id: string;
  options: SelectOption<T>[];
  isSelected: (v: T) => boolean;
  onPick: (v: T) => void;
  onClose: (refocus: boolean) => void;
  multiple?: boolean;
  label?: string;
  align?: 'start' | 'end';
};

function Listbox<T>({ id, options, isSelected, onPick, onClose, multiple, label, align }: ListboxProps<T>) {
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
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeIdx = Math.min(active, shown.length - 1);

  useEffect(() => {
    (searchable ? searchRef.current : listRef.current)?.focus();
  }, [searchable]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const move = (delta: number | 'first' | 'last') => {
    if (!shown.length) return;
    if (delta === 'first') return setActive(0);
    if (delta === 'last') return setActive(shown.length - 1);
    setActive((i) => (Math.min(i, shown.length - 1) + delta + shown.length) % shown.length);
  };

  const pick = (o: SelectOption<T> | undefined) => {
    if (!o || o.disabled) return;
    onPick(o.value);
    if (!multiple) onClose(true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
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
            if (shown[i]!.label.toLowerCase().startsWith(k)) {
              setActive(i);
              break;
            }
          }
        }
    }
  };

  return (
    <div className={`ui-panel${align === 'end' ? ' ui-panel--right' : ''}`} onKeyDown={onKeyDown}>
      {searchable && (
        <div className="ui-panel-search">
          <input
            ref={searchRef}
            className="ui-input ui-input--sm"
            placeholder="搜尋…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            aria-controls={id}
            aria-activedescendant={shown.length ? `${id}-opt-${activeIdx}` : undefined}
            aria-label="搜尋選項"
          />
        </div>
      )}
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        aria-activedescendant={shown.length ? `${id}-opt-${activeIdx}` : undefined}
        tabIndex={-1}
        className="ui-panel-list"
        style={{ outline: 'none' }}
      >
        {shown.length === 0 && <div className="ui-panel-empty">沒有符合的項目</div>}
        {shown.map((o, i) => {
          const selected = isSelected(o.value);
          return (
            <div
              key={`${String(o.value)}`}
              id={`${id}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={selected}
              aria-disabled={o.disabled || undefined}
              data-highlighted={i === activeIdx}
              className="ui-option"
              onPointerMove={() => setActive(i)}
              onClick={() => pick(o)}
            >
              {multiple && <Checkbox checked={selected} readOnly tabIndex={-1} aria-hidden="true" />}
              {o.leading}
              <span className="ui-option-label">{o.label}</span>
              {!multiple && selected && <Icon name="check" className="ui-option-check" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type TriggerProps = {
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** 已設定樣式（accent-soft 底） */
  active?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  align?: 'start' | 'end';
};

function usePopoverState() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(open, anchorRef, dismiss);
  return { open, setOpen, anchorRef, triggerRef, close };
}

function triggerKeyDown(setOpen: (v: boolean) => void) {
  return (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };
}

/** 單選下拉 */
export function Select<T extends string | number>({
  options,
  value,
  onChange,
  placeholder = '請選擇',
  renderValue,
  ...trigger
}: TriggerProps & {
  options: SelectOption<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  placeholder?: string;
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode;
}) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  const listId = useId();
  const current = options.find((o) => o.value === value);
  return (
    <span ref={anchorRef} className={`ui-popover-anchor ${trigger.className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        id={trigger.id}
        className="ui-select-trigger"
        style={{ width: '100%', fontWeight: 'var(--font-regular)' }}
        data-active={trigger.active || undefined}
        disabled={trigger.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={trigger['aria-label']}
        aria-describedby={trigger['aria-describedby']}
        aria-invalid={trigger.invalid || undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={triggerKeyDown(setOpen)}
      >
        {renderValue ? (
          renderValue(current)
        ) : (
          <>
            {current?.leading}
            <span
              className="ui-select-label"
              style={{
                flex: 1,
                textAlign: 'left',
                color: current ? undefined : 'var(--color-text-tertiary)',
              }}
            >
              {current?.label ?? placeholder}
            </span>
          </>
        )}
        <Icon name="chevronDown" className="ui-select-chevron" />
      </button>
      {open && (
        <Listbox
          id={listId}
          options={options}
          isSelected={(v) => v === value}
          onPick={onChange}
          onClose={close}
          label={trigger['aria-label']}
          align={trigger.align}
        />
      )}
    </span>
  );
}

/**
 * 多選下拉（FilterBar 用）。觸發鈕：未設定顯示 label；已設定為 accent-soft 樣式，
 * 文字為「label：第一項」，多個時加「 +N」。
 */
export function MultiSelect<T extends string | number>({
  label,
  options,
  value,
  onChange,
  ...trigger
}: TriggerProps & {
  label: string;
  options: SelectOption<T>[];
  value: T[];
  onChange: (value: T[]) => void;
}) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  const listId = useId();
  const selected = options.filter((o) => value.includes(o.value));
  const active = trigger.active ?? value.length > 0;
  const text =
    value.length === 0
      ? label
      : `${label}：${selected[0]?.label ?? value.length}${value.length > 1 ? ` +${value.length - 1}` : ''}`;
  return (
    <span ref={anchorRef} className={`ui-popover-anchor ${trigger.className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        id={trigger.id}
        className="ui-select-trigger"
        data-active={active || undefined}
        disabled={trigger.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={trigger['aria-label']}
        onClick={() => setOpen(!open)}
        onKeyDown={triggerKeyDown(setOpen)}
      >
        <span className="ui-select-label">{text}</span>
        <Icon name="chevronDown" className="ui-select-chevron" />
      </button>
      {open && (
        <Listbox
          id={listId}
          options={options}
          multiple
          isSelected={(v) => value.includes(v)}
          onPick={(v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])}
          onClose={close}
          label={label}
          align={trigger.align}
        />
      )}
    </span>
  );
}

export type MenuItem =
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      danger?: boolean;
      /** 停用：仍可用鍵盤移到（aria-disabled），但無法執行 */
      disabled?: boolean;
      /** 停用原因：hover 以 title 提示、鍵盤移到時顯示於項目下方，並作為 aria-description */
      disabledReason?: string;
    }
  | { key: string; separator: true }
  | { key: string; content: ReactNode };

/**
 * 動作選單：trigger 為 render function，收到要展開在按鈕上的 props。
 * items 可含分隔線（separator）與不可點的自訂內容（content）。
 */
export function Menu({
  trigger,
  items,
  align = 'start',
  width,
  label,
}: {
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
  }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  width?: number;
  label?: string;
}) {
  const { open, setOpen, anchorRef, triggerRef, close } = usePopoverState();
  // 可移動到的項目（含停用項目，讓鍵盤使用者也能得知停用原因）
  const actionable = items.filter(
    (i): i is Extract<MenuItem, { onSelect: () => void }> => 'onSelect' in i,
  );
  const [active, setActive] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);
  const openMenu = (v: boolean) => {
    if (v) setActive(Math.max(0, actionable.findIndex((i) => !i.disabled)));
    setOpen(v);
  };

  const onKeyDown = (e: KeyboardEvent) => {
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

  return (
    <span ref={anchorRef} className="ui-popover-anchor">
      {trigger({
        ref: triggerRef,
        onClick: () => openMenu(!open),
        onKeyDown: triggerKeyDown(openMenu),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          aria-activedescendant={actionable[active] ? `${menuId}-item-${active}` : undefined}
          tabIndex={-1}
          className={`ui-panel${align === 'end' ? ' ui-panel--right' : ''}`}
          style={{ width, outline: 'none' }}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => {
            if ('separator' in item)
              return <div key={item.key} className="ui-menu-separator" role="separator" />;
            if ('content' in item)
              return (
                <div key={item.key} role="presentation">
                  {item.content}
                </div>
              );
            const idx = actionable.indexOf(item as (typeof actionable)[number]);
            const highlighted = idx === active && idx >= 0;
            const reason = item.disabled ? item.disabledReason : undefined;
            return (
              <div
                key={item.key}
                id={`${menuId}-item-${idx}`}
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                aria-description={reason}
                title={reason}
                data-highlighted={highlighted}
                className={`ui-option${item.danger ? ' ui-option--danger' : ''}`}
                style={reason && highlighted ? { flexWrap: 'wrap' } : undefined}
                onPointerMove={() => idx >= 0 && setActive(idx)}
                onClick={() => {
                  if (item.disabled) return;
                  close(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span className="ui-option-label">{item.label}</span>
                {reason && highlighted && (
                  <span
                    aria-hidden="true"
                    style={{
                      flexBasis: '100%',
                      fontSize: 'var(--text-xs, 12px)',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {reason}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
