import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import { createDb, type Db } from '../../src/server/db/client.ts';
import { runMigrations } from '../../src/server/db/migrate.ts';
import { runSeed } from '../../src/server/db/seed.ts';
import { users } from '../../src/server/db/schema.ts';
import { hashPassword } from '../../src/server/lib/password.ts';

/** 建立已 migration + seed 的記憶體 DB */
export function createTestDb(options: { seed?: boolean } = {}): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  if (options.seed !== false) runSeed(db);
  return db;
}

/** 建立暫存目錄中的 DB 檔（需要檔案時使用）；呼叫 cleanup() 刪除 */
export function createTempDbFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-sheets-'));
  return { path: join(dir, 'test.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 假時鐘：預設固定於 2026-01-05 09:00 (+08:00)，可 advance() */
export function createFakeClock(start = Date.parse('2026-01-05T09:00:00+08:00')) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/** 建立測試用 app（記憶體 DB，可注入時鐘） */
export function createTestApp(options: { now?: () => number } = {}) {
  const db = createTestDb();
  const app = createApp({ db, now: options.now });
  return { app, db };
}

export const TEST_PASSWORD = 'test-password-123';

let userSeq = 0;

/** 建立測試使用者；預設密碼為 TEST_PASSWORD */
export async function createTestUser(
  db: Db,
  overrides: Partial<typeof users.$inferInsert> & { password?: string } = {},
) {
  const { password = TEST_PASSWORD, ...rest } = overrides;
  userSeq += 1;
  const row = db
    .insert(users)
    .values({
      username: `user${userSeq}`,
      displayName: `測試使用者 ${userSeq}`,
      passwordHash: await hashPassword(password),
      role: 'member',
      ...rest,
    })
    .returning()
    .get();
  return { ...row, password };
}
