import { createElement, Fragment } from 'preact';
import { Tooltip } from '../../ui/index.js';
import { badgeInfo } from './checklistModel.js';

/** 方框內打勾（☑）16px 線條圖示；tasks feature 內自繪，不改凍結的 ui */
function BoxCheck({ size = 12 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    createElement('path', { d: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9' }),
  );
}

/** 列表標題旁 / 看板卡片的待辦進度徽章：只在有清單時顯示；全部完成時變成綠色勾 */
export function ChecklistBadge({ task }) {
  const info = badgeInfo(task);
  if (!info) return null;
  return createElement(
    Tooltip,
    { content: info.label },
    createElement(
      'span',
      {
        className: `cl-badge${info.complete ? ' is-complete' : ''}`,
        role: 'img',
        'aria-label': info.label,
        'data-testid': 'checklist-badge',
      },
      info.complete
        ? createElement(BoxCheck, { size: 13 })
        : createElement(Fragment, null, createElement(BoxCheck, null), info.text),
    ),
  );
}
