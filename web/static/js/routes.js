import { createElement, Fragment } from 'preact';
import { createBrowserRouter } from './lib/router.js';
import { AdminUsersPage } from './features/admin/AdminUsersPage.js';
import { DataPage } from './features/admin/DataPage.js';
import { DelayLinkPage } from './features/delay-link/DelayLinkPage.js';
import { PermissionsPage } from './features/admin/PermissionsPage.js';
import { SyncPage } from './features/admin/SyncPage.js';
import { AuditPage } from './features/audit/AuditPage.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { EngPage } from './features/eng/EngPage.js';
import { FeedbackPage } from './features/feedback/FeedbackPage.js';
import { GanttPage } from './features/gantt/GanttPage.js';
import { KanbanPage } from './features/kanban/KanbanPage.js';
import { OverviewPage } from './features/overview/OverviewPage.js';
import { PersonalPage } from './features/personal/PersonalPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { ListPage } from './features/tasks/ListPage.js';
import { PageLayout } from './shell/AppShell.js';
import { NotFoundPage } from './shell/NotFoundPage.js';
import { RequireAuth } from './shell/RequireAuth.js';
import { TaskAreaLayout, TaskIndexRedirect } from './shell/TaskAreaLayout.js';
import { BASE_PATH } from './lib/base.js';

const h = (title) => ({ title });

/**
 * 全部頁面路由（core 一次註冊；各頁元件位於 features/<track>/，由各軌道實作）。
 * 任務區 /tasks/* 由 TaskAreaLayout 提供 ViewTabs + FilterBar。
 */
export const routes = [
  { path: '/login', element: createElement(LoginPage, null), handle: h('登入') },
  {
    path: '/',
    element: createElement(RequireAuth, null),
    children: [
      {
        element: createElement(PageLayout, null),
        children: [
          { index: true, element: createElement(OverviewPage, null), handle: h('總覽') },
          { path: 'feedback', element: createElement(FeedbackPage, null), handle: h('問題回饋') },
          { path: 'me', element: createElement(PersonalPage, null), handle: h('個人清單') },
          { path: 'settings', element: createElement(SettingsPage, null), handle: h('個人設定') },
          { path: 'eng', element: createElement(EngPage, null), handle: h('工程追蹤') },
          { path: 'admin/users', element: createElement(AdminUsersPage, null), handle: h('成員管理') },
          { path: 'admin/data', element: createElement(DataPage, null), handle: h('資料管理') },
          { path: 'admin/data/sync', element: createElement(SyncPage, null), handle: h('資料同步') },
          { path: 'admin/permissions', element: createElement(PermissionsPage, null), handle: h('權限設定') },
          { path: 'admin/audit', element: createElement(AuditPage, null), handle: h('稽核紀錄') },
          { path: '*', element: createElement(NotFoundPage, null), handle: h('找不到頁面') },
        ],
      },
      {
        path: 'tasks',
        element: createElement(TaskAreaLayout, null),
        handle: h('任務'),
        children: [
          { index: true, element: createElement(TaskIndexRedirect, null) },
          { path: 'list', element: createElement(ListPage, null), handle: h('任務') },
          { path: 'kanban', element: createElement(KanbanPage, null), handle: h('任務') },
          { path: 'gantt', element: createElement(GanttPage, null), handle: h('任務') },
          { path: 'delay-link', element: createElement(DelayLinkPage, null), handle: h('任務') },
        ],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes, { basename: BASE_PATH || '/' });
