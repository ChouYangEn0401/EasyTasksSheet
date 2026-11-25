import { Link, NavLink, useLocation } from 'react-router';
import { useCapabilities } from '../lib/permissions.ts';
import { readStorage } from '../lib/storage.ts';
import { Button, Icon, Tooltip } from '../ui/index.ts';
import { LAST_TASK_VIEW_KEY, NAV_ENTRIES, TASK_VIEWS, type NavEntry } from './nav.ts';

/** 任務群組標題：進入上次使用的檢視（預設 List） */
function lastTaskViewPath(): string {
  const v = readStorage(LAST_TASK_VIEW_KEY);
  return `/tasks/${(TASK_VIEWS as readonly string[]).includes(v ?? '') ? v : 'list'}`;
}

function NavItemLink({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  const link = (
    <NavLink to={entry.to} end={entry.end ?? entry.to === '/'} className="nav-item">
      <Icon name={entry.icon} />
      <span className="nav-item-label">{entry.label}</span>
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={entry.label} placement="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function TaskGroup({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  const { pathname } = useLocation();
  const inGroup = pathname === '/tasks' || pathname.startsWith('/tasks/');
  return (
    <div className="nav-group">
      {/* 群組標題不套選取底，只把文字轉為主要色 */}
      <Link
        to={lastTaskViewPath()}
        className="nav-item"
        data-group-active={inGroup || undefined}
        aria-label={collapsed ? entry.label : undefined}
      >
        <Icon name={entry.icon} />
        <span className="nav-item-label">{entry.label}</span>
        <Icon name={inGroup ? 'chevronDown' : 'chevronRight'} size={14} className="nav-chevron" />
      </Link>
      {inGroup &&
        entry.children?.map((c) => (
          <NavLink key={c.key} to={c.to} className="nav-item nav-item--sub">
            <span className="nav-item-label">{c.label}</span>
          </NavLink>
        ))}
      {collapsed && (
        <div className="nav-flyout" role="group" aria-label={entry.label}>
          <div className="nav-flyout-title">{entry.label}</div>
          {entry.children?.map((c) => (
            <NavLink key={c.key} to={c.to} className="nav-item">
              <span>{c.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** 側邊導覽（收合時只留圖示，文字以 tooltip 顯示；任務子項改為 hover 浮出選單） */
export function Sidebar({
  collapsed,
  onToggle,
  toggleLabel,
}: {
  collapsed: boolean;
  onToggle: () => void;
  toggleLabel: string;
}) {
  const caps = useCapabilities();
  const main = NAV_ENTRIES.filter((e) => !e.capability);
  const admin = NAV_ENTRIES.filter(
    (e) => e.capability && (e.anyOf ?? [e.capability]).some((c) => caps.has(c)),
  );
  return (
    <aside className="sidebar" data-collapsed={collapsed || undefined}>
      <div className="sidebar-brand">
        <Icon name="logo" className="sidebar-brand-mark" />
        <span className="sidebar-brand-text">TasksSheets</span>
      </div>
      <nav className="sidebar-nav" aria-label="主要導覽">
        {main.map((e) =>
          e.children ? (
            <TaskGroup key={e.key} entry={e} collapsed={collapsed} />
          ) : (
            <NavItemLink key={e.key} entry={e} collapsed={collapsed} />
          ),
        )}
        {admin.length > 0 && (
          <>
            <div className="sidebar-sep" role="separator" />
            {admin.map((e) => (
              <NavItemLink key={e.key} entry={e} collapsed={collapsed} />
            ))}
          </>
        )}
      </nav>
      <div className="sidebar-footer">
        <Tooltip content={collapsed ? toggleLabel : ''} placement="right">
          <Button
            variant="ghost"
            icon={collapsed ? 'chevronsRight' : 'chevronsLeft'}
            onClick={onToggle}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
          >
            <span className="sidebar-footer-label">{toggleLabel}</span>
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}
