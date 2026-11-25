import { createBrowserRouter, type RouteObject } from 'react-router';
import { AdminUsersPage } from './features/admin/AdminUsersPage.tsx';
import { DataPage } from './features/admin/DataPage.tsx';
import { DelayLinkPage } from './features/delay-link/DelayLinkPage.tsx';
import { PermissionsPage } from './features/admin/PermissionsPage.tsx';
import { SyncPage } from './features/admin/SyncPage.tsx';
import { AuditPage } from './features/audit/AuditPage.tsx';
import { LoginPage } from './features/auth/LoginPage.tsx';
import { EngPage } from './features/eng/EngPage.tsx';
import { FeedbackPage } from './features/feedback/FeedbackPage.tsx';
import { GanttPage } from './features/gantt/GanttPage.tsx';
import { KanbanPage } from './features/kanban/KanbanPage.tsx';
import { OverviewPage } from './features/overview/OverviewPage.tsx';
import { PersonalPage } from './features/personal/PersonalPage.tsx';
import { SettingsPage } from './features/settings/SettingsPage.tsx';
import { ListPage } from './features/tasks/ListPage.tsx';
import { PageLayout, type RouteHandle } from './shell/AppShell.tsx';
import { NotFoundPage } from './shell/NotFoundPage.tsx';
import { RequireAuth } from './shell/RequireAuth.tsx';
import { TaskAreaLayout, TaskIndexRedirect } from './shell/TaskAreaLayout.tsx';
import { BASE_PATH } from './lib/base.ts';

const h = (title: string): RouteHandle => ({ title });

/**
 * 全部頁面路由（core 一次註冊；各頁元件位於 features/<track>/，由各軌道實作）。
 * 任務區 /tasks/* 由 TaskAreaLayout 提供 ViewTabs + FilterBar。
 */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage />, handle: h('登入') },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      {
        element: <PageLayout />,
        children: [
          { index: true, element: <OverviewPage />, handle: h('總覽') },
          { path: 'feedback', element: <FeedbackPage />, handle: h('問題回饋') },
          { path: 'me', element: <PersonalPage />, handle: h('個人清單') },
          { path: 'settings', element: <SettingsPage />, handle: h('個人設定') },
          { path: 'eng', element: <EngPage />, handle: h('工程追蹤') },
          { path: 'admin/users', element: <AdminUsersPage />, handle: h('成員管理') },
          { path: 'admin/data', element: <DataPage />, handle: h('資料管理') },
          { path: 'admin/data/sync', element: <SyncPage />, handle: h('資料同步') },
          { path: 'admin/permissions', element: <PermissionsPage />, handle: h('權限設定') },
          { path: 'admin/audit', element: <AuditPage />, handle: h('稽核紀錄') },
          { path: '*', element: <NotFoundPage />, handle: h('找不到頁面') },
        ],
      },
      {
        path: 'tasks',
        element: <TaskAreaLayout />,
        handle: h('任務'),
        children: [
          { index: true, element: <TaskIndexRedirect /> },
          { path: 'list', element: <ListPage />, handle: h('任務') },
          { path: 'kanban', element: <KanbanPage />, handle: h('任務') },
          { path: 'gantt', element: <GanttPage />, handle: h('任務') },
          { path: 'delay-link', element: <DelayLinkPage />, handle: h('任務') },
        ],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes, { basename: BASE_PATH || '/' });
