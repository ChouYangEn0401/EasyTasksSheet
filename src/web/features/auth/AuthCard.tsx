import type { ReactNode } from 'react';
import { Icon } from '../../ui/index.ts';

/** 登入頁 / 強制改密碼共用的置中卡片版型 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="flex flex-col gap-1">
          <div className="sidebar-brand" style={{ height: 'auto', padding: 0, marginBottom: 8 }}>
            <Icon name="logo" className="sidebar-brand-mark" />
            <span>TasksSheets</span>
          </div>
          <h1 className="auth-title">{title}</h1>
          {subtitle && <p className="m-0 text-sm text-secondary">{subtitle}</p>}
        </div>
        {children}
      </div>
      {footer}
    </main>
  );
}
