import { createElement, Fragment } from 'preact';
import { errorMessage } from '../lib/api.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

/** 空狀態：置中 40px 圖示 + 標題 + 說明 + 可選一個動作 */
export function EmptyState({ icon = 'inbox', title, description, action }) {
  return createElement(
    'div',
    { className: 'ui-empty' },
    createElement(Icon, { name: icon, size: 40, className: 'ui-empty-icon' }),
    createElement('p', { className: 'ui-empty-title' }, title),
    description != null && createElement('p', { className: 'ui-empty-desc' }, description),
    action != null && createElement('div', { className: 'ui-empty-action' }, action),
  );
}

/** 錯誤狀態：「載入失敗」+ 錯誤訊息 +「重試」 */
export function ErrorState({ error, onRetry, title = '載入失敗' }) {
  return createElement(
    'div',
    { className: 'ui-empty ui-empty--error', role: 'alert' },
    createElement(Icon, { name: 'alertCircle', size: 40, className: 'ui-empty-icon' }),
    createElement('p', { className: 'ui-empty-title' }, title),
    error != null && createElement('p', { className: 'ui-empty-desc' }, errorMessage(error)),
    onRetry &&
      createElement(
        'div',
        { className: 'ui-empty-action' },
        createElement(Button, { variant: 'secondary', icon: 'refresh', onClick: onRetry }, '重試'),
      ),
  );
}

/** 尚未實作的頁面 */
export function PlaceholderPage({ title }) {
  return createElement(EmptyState, { icon: 'tool', title: title, description: '此功能開發中' });
}
