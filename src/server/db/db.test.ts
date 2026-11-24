import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDbFile, createTestDb, createTestUser } from '../../../tests/helpers/db.ts';
import { createDb } from './client.ts';
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts';
import { DEFAULT_STATUSES, runSeed } from './seed.ts';
import { projects, repos, statuses, tasks, worktreeSnapshots } from './schema.ts';

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

  it('舊 DB（只套用 0000）升級：worktree_snapshots 補上 is_merged（預設 0），既有資料保留', () => {
    const tmp = createTempDbFile();
    const oldDir = mkdtempSync(join(tmpdir(), 'tasks-sheets-mig-'));
    cleanup = () => {
      tmp.cleanup();
      rmSync(oldDir, { recursive: true, force: true });
    };
    // 建立只含第一個 migration 的資料夾，模擬升級前的版本
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));
    const first = journal.entries[0];
    mkdirSync(join(oldDir, 'meta'));
    writeFileSync(join(oldDir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: [first] }));
    copyFileSync(join(MIGRATIONS_DIR, `${first.tag}.sql`), join(oldDir, `${first.tag}.sql`));

    const db = createDb(tmp.path);
    migrate(db, { migrationsFolder: oldDir });
    runSeed(db);
    const columns = (d: typeof db) =>
      d.$client.prepare("select name from pragma_table_info('worktree_snapshots')").pluck().all();
    expect(columns(db)).not.toContain('is_merged');
    const repoId = db.insert(repos).values({ name: 'r', createdAt: 1, updatedAt: 1 }).returning().get().id;
    db.$client
      .prepare(
        'insert into worktree_snapshots (repo_id, path, branch, ahead, reported_at) values (?, ?, ?, ?, ?)',
      )
      .run(repoId, '/dev/wt', 'feat/x', 0, 1);
    db.$client.close();

    const db2 = createDb(tmp.path);
    runMigrations(db2);
    runMigrations(db2);
    expect(columns(db2)).toContain('is_merged');
    const rows = db2.select().from(worktreeSnapshots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoId, path: '/dev/wt', branch: 'feat/x', isMerged: false });
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
