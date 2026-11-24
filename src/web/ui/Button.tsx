import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 前置圖示 */
  icon?: IconName | ReactNode;
  /** 正方形純圖示按鈕（必須提供 aria-label） */
  iconOnly?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
};

/**
 * 按鈕：variant primary / secondary / ghost / danger，size sm(28) / md(32) / lg(40)。
 * loading 時寬度不變、顯示 spinner、aria-busy 且不可點。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
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
  const iconNode = typeof icon === 'string' ? <Icon name={icon as IconName} /> : icon;
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : iconNode}
      {iconOnly ? null : children}
    </button>
  );
});
