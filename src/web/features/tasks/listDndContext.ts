/** 清單拖曳的共用 context（ListDnd.tsx 提供；ListTable 只讀取是否顯示把手） */
import { createContext, useContext } from 'react';
import type { DropMarker } from './listDndModel.ts';

// ── 畫面標記 store（每列只訂閱自己的標記，避免整張表重新渲染） ──

export type View = { activeId: number | null; marker: DropMarker | null };

export function createViewStore() {
  let view: View = { activeId: null, marker: null };
  const subs = new Set<() => void>();
  return {
    get: () => view,
    set(next: View) {
      view = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}
export type ViewStore = ReturnType<typeof createViewStore>;

/** off = 沒有 tasks.edit（不顯示把手）；disabled = 不分組且排序中（把手停用並說明） */
export type HandleMode = 'off' | 'on' | 'disabled';

export type ListDndCtx = {
  store: ViewStore;
  handles: HandleMode;
  sortLocked: boolean;
  isDragging: () => boolean;
  setCollapsed: (groupKey: string, collapsed: boolean | null) => void;
};

export const ListDndContext = createContext<ListDndCtx | null>(null);

/** 是否顯示拖曳把手（ListTable 用來決定任務列的最左可聚焦欄） */
export function useListDndHandles(): boolean {
  const ctx = useContext(ListDndContext);
  return !!ctx && ctx.handles !== 'off';
}
