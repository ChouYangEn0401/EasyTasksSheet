import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ICONS: Record<AlertTone, IconName> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'alert',
  danger: 'alertCircle',
};

/**
 * 提示列（core §5）：對應語意色的 -soft 底、-border 邊、-text 字。
 * danger / warning 預設 role="alert"，其餘 role="status"。可帶動作與關閉鈕。
 */
export function Alert({
  tone = 'info',
  children,
  action,
  onClose,
  role,
  className = '',
}: {
  tone?: AlertTone;
  children: ReactNode;
  action?: ReactNode;
  onClose?: () => void;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div
      className={`ui-alert ui-alert--${tone} ${className}`}
      role={role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status')}
    >
      <Icon name={ICONS[tone]} />
      <div className="ui-alert-body">{children}</div>
      {action}
      {onClose && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="x"
          aria-label="關閉提示"
          onClick={onClose}
          style={{ margin: '-4px -6px -4px 0', color: 'inherit' }}
        />
      )}
    </div>
  );
}
