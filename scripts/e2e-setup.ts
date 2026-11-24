// E2E 前準備：清除 E2E 專用 DB → migration + seed → 建立固定測試帳號（見 tests/helpers/e2e.ts）。
// 用法：node scripts/e2e-setup.ts（DATABASE_PATH 須為 E2E 專用檔）
import { rmSync } from 'node:fs';
import { config } from '../src/server/config.ts';
import { createDb } from '../src/server/db/client.ts';
import { runMigrations } from '../src/server/db/migrate.ts';
import { runSeed } from '../src/server/db/seed.ts';
import { createUser } from '../src/server/features/users/service.ts';
import { E2E_USERS } from '../tests/helpers/e2eUsers.ts';

const path = config.DATABASE_PATH;
if (!/e2e/.test(path)) {
  console.error(`[e2e] DATABASE_PATH（${path}）不是 E2E 專用檔，拒絕執行`);
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });

const db = createDb(path);
runMigrations(db);
runSeed(db);
await createUser(db, { ...E2E_USERS.admin, role: 'admin', mustChangePassword: false });
await createUser(db, { ...E2E_USERS.member, role: 'member', mustChangePassword: false });
await createUser(db, { ...E2E_USERS.newbie, role: 'member', mustChangePassword: true });
db.$client.close();
console.log(`[e2e] 已重建 ${path} 並建立測試帳號`);
