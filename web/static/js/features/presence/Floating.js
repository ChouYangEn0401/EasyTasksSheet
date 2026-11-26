import { createElement, Fragment } from 'preact';
import { useLayoutEffect, useState } from 'preact/compat';
import { createPortal } from 'preact/compat';

function measure(anchor, gap) {
  const r = anchor.getBoundingClientRect();
  return { top: Math.round(r.bottom + gap), right: Math.max(8, Math.round(window.innerWidth - r.right)) };
}

/**
 * 掛在 document.body 的浮層（頂欄有自己的 stacking context，浮層必須脫離它才能蓋住內容區）。
 * 以 position: fixed 對齊 anchor 的右下方；視窗捲動 / 縮放時重新定位。
 */
export function Floating({ anchor, gap = 8, floatingRef, children, style, ...rest }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => setPos(measure(anchor, gap));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, gap]);
  if (!anchor || !pos) return null;
  return createPortal(
    createElement(
      'div',
      { ref: floatingRef, style: { position: 'fixed', top: pos.top, right: pos.right, ...style }, ...rest },
      children,
    ),
    document.body,
  );
}
