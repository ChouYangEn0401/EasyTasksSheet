import type { Capability } from '../../shared/permissions.ts';
import type { IconName } from '../ui/Icon.tsx';

export type NavEntry = {
  key: string;
  label: string;
  to: string;
  icon: IconName;
  /** 需要的權限（有設定者歸在分隔線下方的「管理」區，無此權限時不顯示） */
  capability?: Capability;
  children?: { key: string; label: string; to: string }[];
};

/** 側邊導覽：所有頁面入口（成員管理、資料管理依 capability 顯示，見 docs/permissions.md） */
export const NAV_ENTRIES: NavEntry[] = [
  { key: 'overview', label: '總覽', to: '/', icon: 'dashboard' },
  {
    key: 'tasks',
    label: '任務',
    to: '/tasks',
    icon: 'listCheck',
    children: [
      { key: 'list', label: '清單', to: '/tasks/list' },
      { key: 'kanban', label: '看板', to: '/tasks/kanban' },
      { key: 'gantt', label: '甘特圖', to: '/tasks/gantt' },
    ],
  },
  { key: 'feedback', label: '問題回饋', to: '/feedback', icon: 'chat' },
  { key: 'me', label: '個人清單', to: '/me', icon: 'user' },
  { key: 'eng', label: '工程追蹤', to: '/eng', icon: 'branch' },
  { key: 'admin', label: '成員管理', to: '/admin/users', icon: 'usersCog', capability: 'members.manage' },
  {
    key: 'admin-data',
    label: '資料管理',
    to: '/admin/data',
    icon: 'inbox',
    capability: 'data.export_json',
  },
  {
    key: 'admin-permissions',
    label: '權限設定',
    to: '/admin/permissions',
    icon: 'key',
    capability: 'permissions.configure',
  },
];

export const TASK_VIEWS = ['list', 'kanban', 'gantt'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export const LAST_TASK_VIEW_KEY = 'ts.lastTaskView';
export const SIDEBAR_PREF_KEY = 'ts.sidebar';
