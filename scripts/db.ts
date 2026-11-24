// 用法：node scripts/db.ts <migrate|seed|setup>
import { config } from '../src/server/config.ts';
import { createDb } from '../src/server/db/client.ts';
import { runMigrations } from '../src/server/db/migrate.ts';
import { runSeed } from '../src/server/db/seed.ts';

const cmd = process.argv[2];
if (!cmd || !['migrate', 'seed', 'setup'].includes(cmd)) {
  console.error('用法：node scripts/db.ts <migrate|seed|setup>');
  process.exit(1);
}

const db = createDb(config.DATABASE_PATH);
if (cmd === 'migrate' || cmd === 'setup') {
  runMigrations(db);
  console.log(`[db] migration 完成：${config.DATABASE_PATH}`);
}
if (cmd === 'seed' || cmd === 'setup') {
  runSeed(db);
  console.log('[db] seed 完成');
}
db.$client.close();
