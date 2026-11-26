/** changes 表的 entity_type；所有寫入 API 透過 recordChange() 記錄 */
export const ENTITY_TYPES = [
  'user',
  'project',
  'status',
  'task',
  'property',
  'feedback',
  'personal',
  'repo',
  'worktree_plan',
  // 權限設定（entityId 固定為 0）：前端重抓 /api/auth/me 更新 capabilities
  'permission',
  // 任務討論區的留言（entityId = 留言 id）：前端重抓討論區與清單的留言徽章
  'task_comment',
];

export const CHANGE_ACTIONS = ['create', 'update', 'delete'];
