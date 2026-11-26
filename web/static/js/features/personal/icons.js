import { createElement, Fragment } from 'preact';
/** 個人清單專用的 16px 線條圖示（core Icon 尚無書籤 / 把手） */

function Svg({ d, fill = 'none' }) {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: fill,
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    createElement('path', { d: d }),
  );
}

export function BookmarkIcon({ filled }) {
  return createElement(Svg, { d: 'M6 3h12v18l-6-4-6 4z', fill: filled ? 'currentColor' : 'none' });
}

export function GripIcon() {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    [6, 12, 18].map((y) =>
      createElement(
        'g',
        { key: y },
        createElement('circle', { cx: 9, cy: y, r: 1.5 }),
        createElement('circle', { cx: 15, cy: y, r: 1.5 }),
      ),
    ),
  );
}
