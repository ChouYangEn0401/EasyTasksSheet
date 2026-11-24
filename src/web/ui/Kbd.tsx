import type { ReactNode } from 'react';

/** 鍵盤按鍵提示 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
