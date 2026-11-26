import { createElement, Fragment } from 'preact';
import { Tooltip } from '../../ui/index.js';
import { relationCountLabel } from './relationModel.js';

/** 連結圖示（core Icon 尚無 link；同 Icon 的 1.5px 線條風格） */
export function LinkIcon({ size = 14 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.75,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    createElement('path', {
      d: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    }),
  );
}

/** 清單列 / 看板卡片：relationCount > 0 時顯示「🔗 N」（不可聚焦，避免破壞 roving tabindex） */
export function RelationBadge({ count }) {
  if (!count || count <= 0) return null;
  const label = relationCountLabel(count);
  return createElement(
    Tooltip,
    { content: label },
    createElement(
      'span',
      { className: 'tr-badge', role: 'img', 'aria-label': label, 'data-testid': 'relation-badge' },
      createElement(LinkIcon, { size: 12 }),
      createElement('span', { 'aria-hidden': 'true' }, count),
    ),
  );
}
