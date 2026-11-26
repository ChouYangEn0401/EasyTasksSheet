import { createElement, Fragment } from 'preact';
import { forwardRef } from 'preact/compat';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';

const ICONS = {
  success: 'checkCircle',
  danger: 'alertCircle',
  info: 'info',
  warning: 'alert',
};

/**
 * Toast 外觀（佇列與計時見 lib/toast.ts，掛載於 GlobalOverlays）。
 * 放在 <ToastViewport> 內（右下固定、新的在最下方）。
 * - leaving：播放離場動畫（docs/design/realtime-feedback.md §3）
 * - busy：以 Spinner 取代圖示（連線重試中）
 * - lead：標題前的元素（他人變更提示的頭像）
 */
export const Toast = forwardRef(function Toast(
  { tone = 'info', title, description, action, onClose, leaving, busy, lead, onKeyDown, tabIndex },
  ref,
) {
  return createElement(
    'div',
    {
      ref: ref,
      className: `ui-toast ui-toast--${tone}`,
      role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status',
      'data-leaving': leaving || undefined,
      tabIndex: tabIndex,
      onKeyDown: onKeyDown,
    },
    busy
      ? createElement(
          'span',
          { className: 'ui-toast-icon ui-toast-spinner' },
          createElement(Spinner, { size: 20 }),
        )
      : createElement(Icon, { name: ICONS[tone], size: 20, className: 'ui-toast-icon' }),
    createElement(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      createElement('div', { className: 'ui-toast-title' }, lead, title),
      description != null && createElement('div', { className: 'ui-toast-desc' }, description),
    ),
    action,
    onClose &&
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: 'x',
        'aria-label': '關閉通知',
        onClick: onClose,
      }),
  );
});

export function ToastViewport({ children, onPointerEnter, onPointerLeave, onFocus, onBlur }) {
  return createElement(
    'div',
    {
      className: 'toast-viewport',
      role: 'region',
      'aria-label': '通知',
      onPointerEnter: onPointerEnter,
      onPointerLeave: onPointerLeave,
      onFocus: onFocus,
      onBlur: onBlur,
    },
    children,
  );
}
