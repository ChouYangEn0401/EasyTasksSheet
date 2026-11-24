import { forwardRef, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Spinner } from './Spinner.tsx';

export type ToastTone = 'success' | 'danger' | 'info' | 'warning';

const ICONS: Record<ToastTone, IconName> = {
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
export const Toast = forwardRef<
  HTMLDivElement,
  {
    tone?: ToastTone;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    onClose?: () => void;
    leaving?: boolean;
    busy?: boolean;
    lead?: ReactNode;
    onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
    tabIndex?: number;
  }
>(function Toast(
  { tone = 'info', title, description, action, onClose, leaving, busy, lead, onKeyDown, tabIndex },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`ui-toast ui-toast--${tone}`}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-leaving={leaving || undefined}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
    >
      {busy ? (
        <span className="ui-toast-icon ui-toast-spinner">
          <Spinner size={20} />
        </span>
      ) : (
        <Icon name={ICONS[tone]} size={20} className="ui-toast-icon" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ui-toast-title">
          {lead}
          {title}
        </div>
        {description != null && <div className="ui-toast-desc">{description}</div>}
      </div>
      {action}
      {onClose && (
        <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="關閉通知" onClick={onClose} />
      )}
    </div>
  );
});

export function ToastViewport({
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
}: {
  children?: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="toast-viewport"
      role="region"
      aria-label="通知"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
    </div>
  );
}
