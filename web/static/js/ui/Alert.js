import { createElement, Fragment } from 'preact';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

const ICONS = {
  info: 'info',
  success: 'checkCircle',
  warning: 'alert',
  danger: 'alertCircle',
};

/**
 * 提示列（core §5）：對應語意色的 -soft 底、-border 邊、-text 字。
 * danger / warning 預設 role="alert"，其餘 role="status"。可帶動作與關閉鈕。
 */
export function Alert({ tone = 'info', children, action, onClose, role, className = '' }) {
  return createElement(
    'div',
    {
      className: `ui-alert ui-alert--${tone} ${className}`,
      role: role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status'),
    },
    createElement(Icon, { name: ICONS[tone] }),
    createElement('div', { className: 'ui-alert-body' }, children),
    action,
    onClose &&
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: 'x',
        'aria-label': '關閉提示',
        onClick: onClose,
        style: { margin: '-4px -6px -4px 0', color: 'inherit' },
      }),
  );
}
