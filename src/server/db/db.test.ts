import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDbFile, createTestDb, createTestUser } from '../../../tests/helpers/db.ts';
import { createDb } from './client.ts';
import { runMigrations } from './migrate.ts';
import { DEFAULT_STATUSES, runSeed } from './seed.ts';
import { projects, statuses, tasks } from './schema.ts';

const ALL_TABLES = [
  'changes',
  'feedback_items',
  'git_issues_cache',
  'login_attempts',
  'personal_items',
  'projects',
  'property_defs',
  'repos',
  'sessions',
  'statuses',
  'tasks',
  'users',
  'worktree_plans',
  'worktree_snapshots',
];

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('migration + seed', () => {
  it('空 DB 檔建立完整 schema，重跑 migration 與 seed 無副作用', () => {
    const tmp = createTempDbFile();
    cleanup = tmp.cleanup;

    const db = createDb(tmp.path);
    runMigrations(db);
    runSeed(db);
    const tableNames = () =>
      db.$client
        .prepare(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
        )
        .pluck()
        .all();
    expect(tableNames()).toEqual(ALL_TABLES);
    db.$client.close();

    // 重新開啟後再跑一次
    const db2 = createDb(tmp.path);
    runMigrations(db2);
    runSeed(db2);
    runSeed(db2);
    expect(db2.select().from(statuses).all()).toHaveLength(DEFAULT_STATUSES.length);
    expect(db2.select().from(projects).all()).toHaveLength(1);
    expect(db2.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    db2.$client.close();
  });

  it('任務只需 title 即可建立，更新時 updated_at 自動寫入', async () => {
    const db = createTestDb();
    const user = await createTestUser(db);
    const project = db.select().from(projects).get()!;
    const status = db.select().from(statuses).get()!;

    const created = db
      .insert(tasks)
      .values({
        title: '寫報告',
        projectId: project.id,
        statusId: status.id,
        createdBy: user.id,
        updatedAt: 1,
      })
      .returning()
      .get();
    expect(created.custom).toEqual({});
    expect(created.progress).toBe(0);
    expect(created.deletedAt).toBeNull();

    const updated = db
      .update(tasks)
      .set({ title: '寫期末報告', updatedBy: user.id })
      .where(eq(tasks.id, created.id))
      .returning()
      .get();
    expect(updated.updatedAt).toBeGreaterThan(1);
    expect(updated.updatedBy).toBe(user.id);
  });

  it('外鍵約束有效', () => {
    const db = createTestDb();
    expect(() => db.insert(tasks).values({ title: 'x', projectId: 999, statusId: 999 }).run()).toThrow();
  });
});
