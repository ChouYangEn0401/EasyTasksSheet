import { createElement, Fragment } from 'preact';
import { Icon } from '../../ui/index.js';

/** 登入頁 / 強制改密碼共用的置中卡片版型 */
export function AuthCard({ title, subtitle, children, footer }) {
  return createElement(
    'main',
    { className: 'auth-page' },
    createElement(
      'div',
      { className: 'auth-card' },
      createElement(
        'div',
        { className: 'flex flex-col gap-1' },
        createElement(
          'div',
          { className: 'sidebar-brand', style: { height: 'auto', padding: 0, marginBottom: 8 } },
          createElement(Icon, { name: 'logo', className: 'sidebar-brand-mark' }),
          createElement('span', null, 'TasksSheets'),
        ),
        createElement('h1', { className: 'auth-title' }, title),
        subtitle && createElement('p', { className: 'm-0 text-sm text-secondary' }, subtitle),
      ),
      children,
    ),
    footer,
  );
}
