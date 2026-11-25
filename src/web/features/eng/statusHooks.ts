import { createContext, useContext, useMemo } from 'react';
import type { EngStatus, EngStatusKind } from '../../../shared/engManual.ts';
import { useEngStatuses } from './api.ts';
import { statusesOf } from './model.ts';

/** 某一類的狀態清單（依排序；含封存） */
export function useStatusList(kind: EngStatusKind): EngStatus[] {
  const q = useEngStatuses();
  return useMemo(() => statusesOf(q.data?.statuses, kind), [q.data, kind]);
}

/** 狀態對話框的開關（StatusAdminProvider 提供） */
export type StatusAdminState =
  | { mode: 'add'; kind: EngStatusKind; onCreated?: (key: string) => void }
  | { mode: 'manage'; kind: EngStatusKind }
  | null;

export const StatusAdminContext = createContext<(s: StatusAdminState) => void>(() => {});

export const useStatusAdmin = () => useContext(StatusAdminContext);
