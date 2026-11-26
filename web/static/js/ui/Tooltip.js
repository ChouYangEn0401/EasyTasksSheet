import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/compat';

/**
 * 深色小提示：hover 延遲 400ms 顯示，鍵盤 focus 立即顯示，Esc 隱藏。
 * 子元素會被包在 inline-flex 的 span 內；tooltip 以 aria-describedby 關聯。
 */
export function Tooltip({ content, children, placement = 'top', disabled }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(undefined);
  const id = useId();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = (delay) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  if (disabled || content == null || content === '') return createElement(Fragment, null, children);
  return createElement(
    'span',
    {
      className: 'ui-tooltip-anchor',
      onPointerEnter: () => show(400),
      onPointerLeave: hide,
      onFocus: (e) => {
        if (e.target.matches(':focus-visible')) show(0);
      },
      onBlur: hide,
      onKeyDown: (e) => {
        if (e.key === 'Escape' && open) hide();
      },
      'aria-describedby': open ? id : undefined,
    },
    children,
    open &&
      createElement(
        'span',
        {
          role: 'tooltip',
          id: id,
          className: `ui-tooltip${placement === 'top' ? '' : ` ui-tooltip--${placement}`}`,
        },
        content,
      ),
  );
}
