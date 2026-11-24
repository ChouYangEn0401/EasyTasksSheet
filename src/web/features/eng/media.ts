import { useSyncExternalStore } from 'react';

/** 訂閱 CSS media query */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** 寬度斷點（design §6）：≥1280 顯示全部欄位 */
export const useIsWide = () => useMediaQuery('(min-width: 1280px)');
