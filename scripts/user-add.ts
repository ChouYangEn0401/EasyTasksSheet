// 用法：npm run user:add -- <帳號> [--name 顯示名稱] [--admin] [--password 密碼]
// 未給密碼則產生隨機密碼並顯示一次；新帳號首次登入需改密碼。
import { parseArgs } from 'node:util';
import { config } from '../src/server/config.ts';
import { createDb } from '../src/server/db/client.ts';
import { runMigrations } from '../src/server/db/migrate.ts';
import { createUser, randomPassword } from '../src/server/features/users/service.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    admin: { type: 'boolean', default: false },
    password: { type: 'string' },
  },
});

const username = positionals[0]?.trim();
if (!username) {
  console.error('用法：npm run user:add -- <帳號> [--name 顯示名稱] [--admin] [--password 密碼]');
  process.exit(1);
}
if (values.password !== undefined && values.password.length < 8) {
  console.error('密碼至少 8 個字元');
  process.exit(1);
}

const db = createDb(config.DATABASE_PATH);
runMigrations(db);
const password = values.password ?? randomPassword();
try {
  const user = await createUser(db, {
    username,
    displayName: values.name,
    password,
    role: values.admin ? 'admin' : 'member',
  });
  console.log(
    `[user:add] 已建立 ${user.role === 'admin' ? '管理員' : '成員'} ${user.username}（id ${user.id}）`,
  );
  if (values.password === undefined)
    console.log(`[user:add] 初始密碼：${password}（只顯示這一次，首次登入需變更）`);
} catch (err) {
  console.error(String(err).includes('UNIQUE') ? `帳號 ${username} 已存在` : err);
  process.exitCode = 1;
} finally {
  db.$client.close();
}
