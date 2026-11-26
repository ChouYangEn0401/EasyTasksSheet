import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { useNavigate } from '../lib/router.js';
import { PresenceStack } from '../features/presence/PresenceStack.js';
import { QuickAdd } from '../features/tasks/QuickAdd.js';
import { UndoButtons } from '../features/undo/UndoButtons.js';
import { logout, useCurrentUser } from '../lib/auth.js';
import { ROLE_BADGE_TONES, ROLE_LABELS } from '../lib/permissions.js';
import { Avatar, Badge, Button, Icon, Menu } from '../ui/index.js';
import { ChangePasswordDialog } from './ChangePasswordDialog.js';

/** 頂欄：頁面標題、全域 QuickAdd、復原 / 重做、使用者選單（變更密碼、登出） */
export function Header({ title, onOpenMenu, onPasswordChanged }) {
  const user = useCurrentUser();
  const [pwOpen, setPwOpen] = useState(false);
  const navigate = useNavigate();
  return createElement(
    'header',
    { className: 'header' },
    createElement(Button, {
      variant: 'ghost',
      iconOnly: true,
      icon: 'menu',
      'aria-label': '開啟導覽選單',
      className: 'header-menu-btn',
      onClick: onOpenMenu,
    }),
    createElement('h1', { className: 'header-title' }, title),
    createElement(
      'div',
      { className: 'header-quickadd' },
      createElement(QuickAdd, { global: true, fullWidth: true }),
    ),
    user && createElement(UndoButtons, null),
    user && createElement(PresenceStack, { title: title }),
    user &&
      createElement(Menu, {
        align: 'end',
        width: 220,
        label: '使用者選單',
        trigger: (props) =>
          createElement(
            'button',
            {
              type: 'button',
              className: 'user-trigger',
              'aria-label': `使用者選單：${user.displayName}`,
              ...props,
            },
            createElement(Avatar, { user: user, size: 'md', tooltip: false }),
            createElement('span', { className: 'user-trigger-name' }, user.displayName),
            createElement(Icon, { name: 'chevronDown', className: 'text-tertiary' }),
          ),
        items: [
          {
            key: 'info',
            content: createElement(
              'div',
              { className: 'user-menu-info' },
              createElement(
                'span',
                { className: 'flex items-center gap-2' },
                createElement('span', { className: 'truncate font-medium' }, user.displayName),
                user.role !== 'user' &&
                  createElement(Badge, { tone: ROLE_BADGE_TONES[user.role] }, ROLE_LABELS[user.role]),
              ),
              createElement('span', { className: 'text-xs text-tertiary' }, '@', user.username),
            ),
          },
          { key: 'sep', separator: true },
          {
            key: 'settings',
            label: '個人設定',
            icon: createElement(Icon, { name: 'user' }),
            onSelect: () => void navigate('/settings'),
          },
          {
            key: 'password',
            label: '變更密碼',
            icon: createElement(Icon, { name: 'key' }),
            onSelect: () => setPwOpen(true),
          },
          {
            key: 'logout',
            label: '登出',
            icon: createElement(Icon, { name: 'logout' }),
            danger: true,
            onSelect: () => void logout(),
          },
        ],
      }),
    createElement(ChangePasswordDialog, {
      open: pwOpen,
      onClose: () => setPwOpen(false),
      onSuccess: onPasswordChanged,
    }),
  );
}
