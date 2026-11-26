import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef } from 'preact/compat';
import { Button } from './Button.js';

/**
 * 對話框（原生 <dialog> + showModal：focus trap、Esc、背景不可操作）。
 * - 開啟時 focus 移入第一個可互動元素（或 [data-autofocus]），關閉後 focus 回到觸發元素
 * - Esc 與點遮罩關閉；dismissible=false 時兩者皆無效（強制型）
 * - dirty=true（表單有未存內容）時點遮罩不關閉
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  size = 'sm',
  dismissible = true,
  dirty = false,
  role = 'dialog',
  showClose,
}) {
  const ref = useRef(null);
  const returnTo = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
      const target =
        el.querySelector('[data-autofocus]') ??
        el.querySelector(
          '.ui-dialog-body input:not([disabled]), .ui-dialog-body textarea:not([disabled]), .ui-dialog-body select:not([disabled]), .ui-dialog-body button:not([disabled])',
        );
      target?.focus();
    } else if (!open && el.open) {
      el.close();
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [open]);

  return createElement(
    'dialog',
    {
      ref: ref,
      className: `ui-dialog${size === 'md' ? ' ui-dialog--md' : size === 'lg' ? ' ui-dialog--lg' : ''}`,
      role: role === 'alertdialog' ? 'alertdialog' : undefined,
      'aria-labelledby': titleId,
      onCancel: (e) => {
        e.preventDefault();
        if (dismissible) onClose();
      },
      onClick: (e) => {
        // 點在 <dialog> 本身（即遮罩區域）才算點遮罩
        if (e.target === e.currentTarget && dismissible && !dirty) {
          const r = e.currentTarget.getBoundingClientRect();
          const inside =
            e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) onClose();
        }
      },
    },
    open &&
      createElement(
        Fragment,
        null,
        createElement(
          'div',
          { className: 'ui-dialog-header' },
          createElement('h2', { id: titleId, className: 'ui-dialog-title' }, title),
          (showClose ?? dismissible) &&
            createElement(Button, {
              variant: 'ghost',
              size: 'sm',
              iconOnly: true,
              icon: 'x',
              'aria-label': '關閉',
              onClick: onClose,
            }),
        ),
        children != null && createElement('div', { className: 'ui-dialog-body' }, children),
        actions != null && createElement('div', { className: 'ui-dialog-actions' }, actions),
      ),
  );
}
