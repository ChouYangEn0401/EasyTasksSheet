import { createElement, Fragment } from 'preact';
import { forwardRef } from 'preact/compat';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';

/**
 * 按鈕：variant primary / secondary / ghost / danger，size sm(28) / md(32) / lg(40)。
 * loading 時寬度不變、顯示 spinner、aria-busy 且不可點。
 */
export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconOnly,
    loading,
    fullWidth,
    className = '',
    type = 'button',
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const cls = [
    'ui-btn',
    `ui-btn--${variant}`,
    size !== 'md' && `ui-btn--${size}`,
    iconOnly && 'ui-btn--icon',
    fullWidth && 'ui-btn--full',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const iconNode = typeof icon === 'string' ? createElement(Icon, { name: icon }) : icon;
  return createElement(
    'button',
    {
      ref: ref,
      type: type,
      className: cls,
      disabled: disabled || loading,
      'aria-busy': loading || undefined,
      ...rest,
    },
    loading ? createElement(Spinner, { size: 14 }) : iconNode,
    iconOnly ? null : children,
  );
});
