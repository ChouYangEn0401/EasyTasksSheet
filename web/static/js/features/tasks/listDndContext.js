/** 清單拖曳的共用 context（ListDnd.tsx 提供；ListTable 只讀取是否顯示把手） */
import { createContext, useContext } from 'preact/compat';

// ── 畫面標記 store（每列只訂閱自己的標記，避免整張表重新渲染） ──

export function createViewStore() {
  let view = { activeId: null, marker: null };
  const subs = new Set();
  return {
    get: () => view,
    set(next) {
      view = next;
      subs.forEach((f) => f());
    },
    subscribe(f) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}

/** off = 沒有 tasks.edit（不顯示把手）；disabled = 不分組且排序中（把手停用並說明） */

export const ListDndContext = createContext(null);

/** 是否顯示拖曳把手（ListTable 用來決定任務列的最左可聚焦欄） */
export function useListDndHandles() {
  const ctx = useContext(ListDndContext);
  return !!ctx && ctx.handles !== 'off';
}
