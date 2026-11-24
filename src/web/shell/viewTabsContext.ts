import { createContext } from 'react';

/** ViewTabs 右側 actions 插槽的 DOM 節點（由 TaskAreaLayout 提供） */
export const ViewTabsActionsContext = createContext<HTMLElement | null>(null);
