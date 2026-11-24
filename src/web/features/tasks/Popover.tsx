import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Checkbox, Icon } from '../../ui/index.ts';

/**
 * 本軌道自建的浮層（core 無 Popover）：外觀沿用 Select 面板（surface、border、radius-lg、shadow-md、z-popover）。
 * 以 portal + fixed 定位錨定在元素下緣左對齊，避免被表格的捲動區塊裁切。
 * 點外部（錨點除外）或 Esc 關閉；Esc 會 preventDefault，避免同時關閉 Drawer。
 */
export function Popover({
  anchor,
  onClose,
  children,
  width,
  label,
  role = 'dialog',
}: {
  anchor: HTMLElement | null;
  onClose: (reason: 'escape' | 'outside') => void;
  children: ReactNode;
  width?: number;
  label?: string;
  role?: 'dialog' | 'presentation';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? width ?? 240;
      const h = el?.offsetHeight ?? 0;
      let left = r.left;
      if (left + w > window.innerWidth - 16) left = Math.max(16, window.innerWidth - 16 - w);
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8 && r.top - 4 - h > 8) top = r.top - 4 - h;
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current('outside');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className="tl-pop"
      role={role}
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          closeRef.current('escape');
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export type Opt<T> = { value: T; label: string; leading?: ReactNode };

/**
 * 面板內的選項清單（單選 / 多選）：↑ ↓ Home End 移動、Enter / Space 選取；
 * 多選或超過 8 項時頂部有篩選輸入。單選選取後由呼叫端關閉。
 */
export function OptionList<T extends string | number | null>({
  options,
  selected,
  multiple,
  onPick,
  label,
  footer,
  forceSearch,
}: {
  options: Opt<T>[];
  selected: T[];
  multiple?: boolean;
  onPick: (value: T) => void;
  label: string;
  footer?: ReactNode;
  forceSearch?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const searchable = forceSearch || multiple || options.length > 8;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => selected.includes(o.value)),
    ),
  );
  const idx = Math.min(active, shown.length - 1);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (searchable ? searchRef.current : listRef.current)?.focus();
  }, [searchable]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const onKeyDown = (e: KeyboardEvent) => {
    const n = shown.length;
    const inSearch = e.target === searchRef.current;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (n) setActive((idx + 1) % n);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (n) setActive((idx - 1 + n) % n);
        return;
      case 'Home':
        if (inSearch) return;
        e.preventDefault();
        return setActive(0);
      case 'End':
        if (inSearch) return;
        e.preventDefault();
        return setActive(Math.max(0, n - 1));
      case 'Enter':
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (shown[idx]) onPick(shown[idx].value);
        return;
      case ' ':
        if (inSearch) return;
        e.preventDefault();
        if (shown[idx]) onPick(shown[idx].value);
        return;
      default:
        // 無搜尋框時：輸入文字跳至相符選項，且不觸發全域快捷鍵
        if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const k = e.key.toLowerCase();
          for (let i = 1; i <= n; i++) {
            const j = (idx + i) % n;
            if (shown[j]!.label.toLowerCase().startsWith(k)) {
              setActive(j);
              break;
            }
          }
        }
    }
  };

  return (
    <div onKeyDown={onKeyDown}>
      {searchable && (
        <div className="ui-panel-search">
          <input
            ref={searchRef}
            className="ui-input ui-input--sm"
            placeholder="搜尋…"
            value={query}
            aria-label="搜尋選項"
            aria-controls={id}
            aria-activedescendant={shown.length ? `${id}-o${idx}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
      )}
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        aria-activedescendant={shown.length ? `${id}-o${idx}` : undefined}
        tabIndex={-1}
        className="ui-panel-list"
        style={{ outline: 'none' }}
      >
        {shown.length === 0 && <div className="ui-panel-empty">沒有符合的項目</div>}
        {shown.map((o, i) => {
          const sel = selected.includes(o.value);
          return (
            <div
              key={String(o.value)}
              id={`${id}-o${i}`}
              data-index={i}
              role="option"
              aria-selected={sel}
              data-highlighted={i === idx}
              className="ui-option"
              onPointerMove={() => setActive(i)}
              onClick={() => onPick(o.value)}
            >
              {multiple && <Checkbox checked={sel} readOnly tabIndex={-1} aria-hidden="true" />}
              {o.leading}
              <span className="ui-option-label">{o.label}</span>
              {!multiple && sel && <Icon name="check" className="ui-option-check" />}
            </div>
          );
        })}
      </div>
      {footer && (
        <>
          <div className="ui-menu-separator" />
          {footer}
        </>
      )}
    </div>
  );
}
