import { useLayoutEffect } from 'preact/compat';

const WIDE = '(min-width: 1280px)';

/**
 * ≥1280px 抽屜浮在內容右側時，表格右側只需讓出「實際被抽屜蓋住」的寬度（docs/design/task-list.md §10）。
 * 以前固定加 --drawer-width，內容區有 max-width 置中時會多出空白並產生不必要的水平捲軸。
 * 量測捲動區右緣與抽屜左緣的重疊量，寫入 --tl-extra（覆蓋 tasks.css 的預設值）。
 */
export function useDrawerInset(scrollRef, open) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!open) {
      el.style.removeProperty('--tl-extra');
      return;
    }
    const measure = () => {
      if (!window.matchMedia(WIDE).matches) {
        el.style.removeProperty('--tl-extra');
        return;
      }
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--drawer-width');
      const drawer = Number.parseFloat(raw) || 480;
      const r = el.getBoundingClientRect();
      const right = r.left + el.clientLeft + el.clientWidth;
      const overlap = Math.max(0, Math.ceil(right - (document.documentElement.clientWidth - drawer)));
      el.style.setProperty('--tl-extra', `${overlap}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      el.style.removeProperty('--tl-extra');
    };
  }, [scrollRef, open]);
}
