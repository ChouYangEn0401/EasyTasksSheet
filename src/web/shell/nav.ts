import type { IconName } from '../ui/Icon.tsx';

export type NavEntry = {
  key: string;
  label: string;
  to: string;
  icon: IconName;
  adminOnly?: boolean;
  children?: { key: string; label: string; to: string }[];
};

/** 側邊導覽：所有頁面入口（成員管理僅 role=admin 顯示） */
export const NAV_ENTRIES: NavEntry[] = [
  { key: 'overview', label: '總覽', to: '/', icon: 'dashboard' },
  {
    key: 'tasks',
    label: '任務',
    to: '/tasks',
    icon: 'listCheck',
    children: [
      { key: 'list', label: 'List', to: '/tasks/list' },
      { key: 'kanban', label: 'Kanban', to: '/tasks/kanban' },
      { key: 'gantt', label: 'Gantt', to: '/tasks/gantt' },
    ],
  },
  { key: 'feedback', label: '問題回饋', to: '/feedback', icon: 'chat' },
  { key: 'me', label: '個人清單', to: '/me', icon: 'user' },
  { key: 'eng', label: '工程追蹤', to: '/eng', icon: 'branch' },
  { key: 'admin', label: '成員管理', to: '/admin/users', icon: 'usersCog', adminOnly: true },
];

export const TASK_VIEWS = ['list', 'kanban', 'gantt'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export const LAST_TASK_VIEW_KEY = 'ts.lastTaskView';
export const SIDEBAR_PREF_KEY = 'ts.sidebar';
