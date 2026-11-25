import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router';
import { Icon, type IconName } from '../ui/index.ts';
import type { TaskView } from './nav.ts';
import { ViewTabsActionsContext } from './viewTabsContext.ts';

const VIEWS: { key: TaskView; label: string; icon: IconName }[] = [
  { key: 'list', label: '清單', icon: 'list' },
  { key: 'kanban', label: '看板', icon: 'kanban' },
  { key: 'gantt', label: '甘特圖', icon: 'gantt' },
  { key: 'delay-link', label: '延遲鏈', icon: 'link' },
];

/**
 * 各任務檢視把自己的控制項（分組、時間刻度…）放進 ViewTabs 右側：
 *   <ViewTabsActions><Select … /></ViewTabsActions>
 */
export function ViewTabsActions({ children }: { children: ReactNode }) {
  const el = useContext(ViewTabsActionsContext);
  return el ? createPortal(children, el) : null;
}

/** 清單 / 看板 / 甘特圖切換；為路由連結，切換時保留目前 query string（篩選不重置） */
export function ViewTabs({ actionsRef }: { actionsRef: (el: HTMLDivElement | null) => void }) {
  const { search } = useLocation();
  return (
    <div className="view-tabs">
      <nav className="view-tabs-nav" aria-label="任務檢視">
        {VIEWS.map((v) => (
          <NavLink key={v.key} to={{ pathname: `/tasks/${v.key}`, search }} className="view-tab">
            <Icon name={v.icon} />
            {v.label}
          </NavLink>
        ))}
      </nav>
      <div ref={actionsRef} className="view-tabs-actions" />
    </div>
  );
}
