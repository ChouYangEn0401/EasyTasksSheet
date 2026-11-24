import type { ReactNode } from 'react';
import { errorMessage } from '../lib/api.ts';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';

/** 空狀態：置中 40px 圖示 + 標題 + 說明 + 可選一個動作 */
export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <Icon name={icon} size={40} className="ui-empty-icon" />
      <p className="ui-empty-title">{title}</p>
      {description != null && <p className="ui-empty-desc">{description}</p>}
      {action != null && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/** 錯誤狀態：「載入失敗」+ 錯誤訊息 +「重試」 */
export function ErrorState({
  error,
  onRetry,
  title = '載入失敗',
}: {
  error?: unknown;
  onRetry?: () => void;
  title?: ReactNode;
}) {
  return (
    <div className="ui-empty ui-empty--error" role="alert">
      <Icon name="alertCircle" size={40} className="ui-empty-icon" />
      <p className="ui-empty-title">{title}</p>
      {error != null && <p className="ui-empty-desc">{errorMessage(error)}</p>}
      {onRetry && (
        <div className="ui-empty-action">
          <Button variant="secondary" icon="refresh" onClick={onRetry}>
            重試
          </Button>
        </div>
      )}
    </div>
  );
}

/** 尚未實作的頁面 */
export function PlaceholderPage({ title }: { title: string }) {
  return <EmptyState icon="tool" title={title} description="此功能開發中" />;
}
