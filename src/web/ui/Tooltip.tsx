import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * 深色小提示：hover 延遲 400ms 顯示，鍵盤 focus 立即顯示，Esc 隱藏。
 * 子元素會被包在 inline-flex 的 span 內；tooltip 以 aria-describedby 關聯。
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  disabled,
}: {
  content: ReactNode;
  children: ReactNode;
  placement?: 'top' | 'bottom' | 'right';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  if (disabled || content == null || content === '') return <>{children}</>;
  return (
    <span
      className="ui-tooltip-anchor"
      onPointerEnter={() => show(400)}
      onPointerLeave={hide}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches(':focus-visible')) show(0);
      }}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) hide();
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`ui-tooltip${placement === 'top' ? '' : ` ui-tooltip--${placement}`}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
