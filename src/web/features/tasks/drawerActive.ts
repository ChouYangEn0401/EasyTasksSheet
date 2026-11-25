import { createContext, useContext } from 'react';

/**
 * 任務抽屜是否仍在使用中（false = 關閉後的離場動畫期間）。
 * 離場中的抽屜不再抓取 / 重抓子資源（相關任務、依賴、待辦清單、活動歷史）：
 * 剛刪除的任務若被重抓只會得到 404（lib/sync.ts 另有排除條件，這裡是補強）。
 */
export const DrawerActiveContext = createContext(true);

export const useDrawerActive = () => useContext(DrawerActiveContext);
