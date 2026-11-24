import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { USER_ROLES } from '../../shared/users.ts';
import { STATUS_CATEGORIES } from '../../shared/projects.ts';
import { PROPERTY_TYPES, type CustomValues, type SelectOption } from '../../shared/properties.ts';
import { TASK_PRIORITIES } from '../../shared/tasks.ts';
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from '../../shared/feedback.ts';
import { CHANGE_ACTIONS, ENTITY_TYPES } from '../../shared/sync.ts';

// 共通規則：時間戳為 unix ms（INTEGER）；純日期為 TEXT 'YYYY-MM-DD'；updated_at 由 $onUpdate 自動寫入。
const now = () => Date.now();
const createdAt = () => integer('created_at').notNull().$defaultFn(now);
const updatedAt = () => integer('updated_at').notNull().$defaultFn(now).$onUpdate(now);
const bool = (name: string) => integer(name, { mode: 'boolean' });

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull().default('member'),
  isActive: bool('is_active').notNull().default(true),
  mustChangePassword: bool('must_change_password').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** session token 的 SHA-256（hex），不存明文 token */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    /** = created_at + 9h，不續期 */
    expiresAt: integer('expires_at').notNull(),
    lastActiveAt: integer('last_active_at').notNull().$defaultFn(now),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: bool('success').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('login_attempts_username_idx').on(t.username, t.createdAt),
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
  ],
);

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#4f6bed'),
  isArchived: bool('is_archived').notNull().default(false),
  sortOrder: real('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const statuses = sqliteTable('statuses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color').notNull(),
  category: text('category', { enum: STATUS_CATEGORIES }).notNull(),
  sortOrder: real('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    statusId: integer('status_id')
      .notNull()
      .references(() => statuses.id),
    assigneeId: integer('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('none'),
    startDate: text('start_date'),
    dueDate: text('due_date'),
    estimateHours: real('estimate_hours'),
    progress: integer('progress').notNull().default(0),
    sortOrder: real('sort_order').notNull().default(0),
    custom: text('custom', { mode: 'json' })
      .$type<CustomValues>()
      .notNull()
      .default(sql`'{}'`),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('tasks_project_idx').on(t.projectId),
    index('tasks_status_idx').on(t.statusId),
    index('tasks_assignee_idx').on(t.assigneeId),
    index('tasks_deleted_idx').on(t.deletedAt),
  ],
);

export const propertyDefs = sqliteTable('property_defs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** null = 全域 */
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: PROPERTY_TYPES }).notNull(),
  options: text('options', { mode: 'json' })
    .$type<SelectOption[]>()
    .notNull()
    .default(sql`'[]'`),
  sortOrder: real('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const feedbackItems = sqliteTable(
  'feedback_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status', { enum: FEEDBACK_STATUSES }).notNull().default('open'),
    scheduledDate: text('scheduled_date'),
    reporterId: integer('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    assigneeId: integer('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('feedback_scheduled_idx').on(t.scheduledDate)],
);

export const personalItems = sqliteTable(
  'personal_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    note: text('note').notNull().default(''),
    isDone: bool('is_done').notNull().default(false),
    /** 有值 = 標記的任務；null = 自由待辦 */
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    sortOrder: real('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('personal_user_idx').on(t.userId),
    // 同一人同一任務只能標記一次（task_id 為 NULL 的自由待辦不受影響）
    uniqueIndex('personal_user_task_uq').on(t.userId, t.taskId),
  ],
);

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  localPath: text('local_path'),
  /** 例：owner/repo */
  remoteSlug: text('remote_slug'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const worktreePlans = sqliteTable('worktree_plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  branch: text('branch').notNull(),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  purpose: text('purpose').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const worktreeSnapshots = sqliteTable(
  'worktree_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch'),
    headSha: text('head_sha'),
    isDirty: bool('is_dirty').notNull().default(false),
    ahead: integer('ahead'),
    behind: integer('behind'),
    lastCommitAt: integer('last_commit_at'),
    isPrunable: bool('is_prunable').notNull().default(false),
    reportedBy: text('reported_by'),
    reportedAt: integer('reported_at').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('worktree_snapshots_repo_path_uq').on(t.repoId, t.path)],
);

export const gitIssuesCache = sqliteTable(
  'git_issues_cache',
  {
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    labels: text('labels', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    assignee: text('assignee'),
    url: text('url').notNull(),
    issueUpdatedAt: integer('issue_updated_at'),
    fetchedAt: integer('fetched_at').notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.number] })],
);

export const changes = sqliteTable(
  'changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type', { enum: ENTITY_TYPES }).notNull(),
    entityId: integer('entity_id').notNull(),
    action: text('action', { enum: CHANGE_ACTIONS }).notNull(),
    actorId: integer('actor_id'),
    createdAt: createdAt(),
  },
  (t) => [index('changes_created_idx').on(t.createdAt)],
);
