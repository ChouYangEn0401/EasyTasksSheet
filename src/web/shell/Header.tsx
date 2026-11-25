import { useState } from 'react';
import { useNavigate } from 'react-router';
import { QuickAdd } from '../features/tasks/QuickAdd.tsx';
import { logout, useCurrentUser } from '../lib/auth.ts';
import { ROLE_BADGE_TONES, ROLE_LABELS } from '../lib/permissions.ts';
import { Avatar, Badge, Button, Icon, Menu } from '../ui/index.ts';
import { ChangePasswordDialog } from './ChangePasswordDialog.tsx';

/** 頂欄：頁面標題、全域 QuickAdd、使用者選單（變更密碼、登出） */
export function Header({
  title,
  onOpenMenu,
  onPasswordChanged,
}: {
  title: string;
  onOpenMenu: () => void;
  onPasswordChanged: () => void;
}) {
  const user = useCurrentUser();
  const [pwOpen, setPwOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <header className="header">
      <Button
        variant="ghost"
        iconOnly
        icon="menu"
        aria-label="開啟導覽選單"
        className="header-menu-btn"
        onClick={onOpenMenu}
      />
      <h1 className="header-title">{title}</h1>
      <div className="header-quickadd">
        <QuickAdd global fullWidth />
      </div>
      {user && (
        <Menu
          align="end"
          width={220}
          label="使用者選單"
          trigger={(props) => (
            <button
              type="button"
              className="user-trigger"
              aria-label={`使用者選單：${user.displayName}`}
              {...props}
            >
              <Avatar user={user} size="md" tooltip={false} />
              <span className="user-trigger-name">{user.displayName}</span>
              <Icon name="chevronDown" className="text-tertiary" />
            </button>
          )}
          items={[
            {
              key: 'info',
              content: (
                <div className="user-menu-info">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{user.displayName}</span>
                    {user.role !== 'user' && (
                      <Badge tone={ROLE_BADGE_TONES[user.role]}>{ROLE_LABELS[user.role]}</Badge>
                    )}
                  </span>
                  <span className="text-xs text-tertiary">@{user.username}</span>
                </div>
              ),
            },
            { key: 'sep', separator: true },
            {
              key: 'settings',
              label: '個人設定',
              icon: <Icon name="user" />,
              onSelect: () => void navigate('/settings'),
            },
            {
              key: 'password',
              label: '變更密碼',
              icon: <Icon name="key" />,
              onSelect: () => setPwOpen(true),
            },
            {
              key: 'logout',
              label: '登出',
              icon: <Icon name="logout" />,
              danger: true,
              onSelect: () => void logout(),
            },
          ]}
        />
      )}
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} onSuccess={onPasswordChanged} />
    </header>
  );
}
