import { createContext, useContext, useMemo } from 'preact/compat';

import { useEngStatuses } from './api.js';
import { statusesOf } from './model.js';

/** 某一類的狀態清單（依排序；含封存） */
export function useStatusList(kind) {
  const q = useEngStatuses();
  return useMemo(() => statusesOf(q.data?.statuses, kind), [q.data, kind]);
}

/** 狀態對話框的開關（StatusAdminProvider 提供） */

export const StatusAdminContext = createContext(() => {});

export const useStatusAdmin = () => useContext(StatusAdminContext);
