import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';

export type ToastTone = 'success' | 'danger' | 'info' | 'warning';

const ICONS: Record<ToastTone, IconName> = {
  success: 'checkCircle',
  danger: 'alertCircle',
  info: 'info',
  warning: 'alert',
};

/**
 * Toast 外觀（core 只提供樣式，佇列與計時由 T9 實作）。
 * 放在 <ToastViewport> 內（右下固定、由下往上堆疊）。
 */
export function Toast({
  tone = 'info',
  title,
  description,
  action,
  onClose,
}: {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      className={`ui-toast ui-toast--${tone}`}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      <Icon name={ICONS[tone]} size={20} className="ui-toast-icon" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ui-toast-title">{title}</div>
        {description != null && <div className="ui-toast-desc">{description}</div>}
      </div>
      {action}
      {onClose && (
        <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="關閉通知" onClick={onClose} />
      )}
    </div>
  );
}

export function ToastViewport({ children }: { children?: ReactNode }) {
  return (
    <div className="toast-viewport" role="region" aria-label="通知">
      {children}
    </div>
  );
}
