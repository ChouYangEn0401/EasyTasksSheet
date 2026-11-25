import { useLayoutEffect, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

type Pos = { top: number; right: number };

function measure(anchor: HTMLElement, gap: number): Pos {
  const r = anchor.getBoundingClientRect();
  return { top: Math.round(r.bottom + gap), right: Math.max(8, Math.round(window.innerWidth - r.right)) };
}

/**
 * 掛在 document.body 的浮層（頂欄有自己的 stacking context，浮層必須脫離它才能蓋住內容區）。
 * 以 position: fixed 對齊 anchor 的右下方；視窗捲動 / 縮放時重新定位。
 */
export function Floating({
  anchor,
  gap = 8,
  floatingRef,
  children,
  style,
  ...rest
}: {
  anchor: HTMLElement | null;
  gap?: number;
  floatingRef?: Ref<HTMLDivElement>;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const [pos, setPos] = useState<Pos | null>(null);
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
    <div ref={floatingRef} style={{ position: 'fixed', top: pos.top, right: pos.right, ...style }} {...rest}>
      {children}
    </div>,
    document.body,
  );
}
