import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** 套用尚未執行的 migration；已套用者會略過，可重複執行 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
