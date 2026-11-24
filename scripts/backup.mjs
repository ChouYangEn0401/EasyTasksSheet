#!/usr/bin/env node
// SQLite 線上備份 / 還原（跨平台：Windows、Linux、macOS）。
//
// 備份（服務運行中也可執行）：
//   node scripts/backup.mjs [--db <資料庫>] [--out <備份目錄>] [--keep <保留份數>]
// 還原（必須先停止服務）：
//   node scripts/backup.mjs restore <備份檔> [--db <資料庫>] --yes
// 自我測試（在暫存目錄演練 備份 → 保留份數 → 還原 → 驗證一致）：
//   node scripts/backup.mjs --self-test
//
// 預設值：--db 取 DATABASE_PATH（會讀取工作目錄的 .env），否則 data/app.db；
//         --out 取 BACKUP_DIR，否則 backups；--keep 取 BACKUP_KEEP，否則 14。
//
// 一致性：使用 `VACUUM INTO`，在單一讀取交易內把資料庫（含尚未 checkpoint 的 WAL 內容）
// 寫成一個獨立、壓實過的 .db 檔；先寫到 .partial 再改名，失敗不會留下半成品。
// 備份完成後執行 PRAGMA integrity_check 驗證。

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const pad = (n) => String(n).padStart(2, '0');

/** 本地時間 YYYYMMDD-HHmmss */
export function timestamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function backupPattern(dbPath) {
  const stem = basename(dbPath, extname(dbPath)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${stem}-\\d{8}-\\d{6}(-\\d+)?\\.db$`);
}

/** 列出某資料庫的備份檔（舊 → 新） */
export function listBackups(dbPath, outDir) {
  if (!existsSync(outDir)) return [];
  const re = backupPattern(dbPath);
  return readdirSync(outDir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => join(outDir, f));
}

/**
 * 驗證檔案完整性。不用唯讀連線：WAL 模式的檔案在沒有 -shm 時唯讀開不起來。
 * toSingleFile 為 true 時同時改為 rollback journal，讓備份檔是不依賴 -wal/-shm 的單一檔案。
 */
function integrityCheck(file, { toSingleFile = false } = {}) {
  const db = new Database(file, { fileMustExist: true });
  try {
    if (toSingleFile) db.pragma('journal_mode = DELETE');
    const rows = db.pragma('integrity_check', { simple: false });
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    if (!ok) throw new Error(`integrity_check 失敗：${JSON.stringify(rows)}`);
  } finally {
    db.close();
  }
}

/**
 * 產生一份一致的備份並依保留份數清除舊檔。
 * @returns {{ file: string, removed: string[] }}
 */
export function backup({ dbPath, outDir, keep = 14, now = new Date() }) {
  if (!existsSync(dbPath)) throw new Error(`找不到資料庫：${dbPath}`);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`保留份數必須是正整數：${keep}`);
  mkdirSync(outDir, { recursive: true });

  const stem = basename(dbPath, extname(dbPath));
  let file = join(outDir, `${stem}-${timestamp(now)}.db`);
  for (let i = 2; existsSync(file); i++) file = join(outDir, `${stem}-${timestamp(now)}-${i}.db`);
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });

  // 不用 readonly：WAL 資料庫在沒有 -shm 檔時唯讀連線可能開不起來。此連線不做任何寫入。
  const src = new Database(dbPath, { fileMustExist: true });
  try {
    src.pragma('busy_timeout = 10000');
    src.prepare('VACUUM INTO ?').run(partial);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    src.close();
  }

  try {
    integrityCheck(partial, { toSingleFile: true });
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  renameSync(partial, file);

  const all = listBackups(dbPath, outDir);
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) rmSync(f, { force: true });
  return { file, removed };
}

/**
 * 以備份檔覆蓋資料庫。呼叫前務必停止服務。
 * 原資料庫（含 -wal / -shm）會先改名為 <db>.before-restore-<時間>，可手動回退。
 * @returns {{ previous: string | null }}
 */
export function restore({ backupFile, dbPath, now = new Date() }) {
  if (!existsSync(backupFile)) throw new Error(`找不到備份檔：${backupFile}`);
  integrityCheck(backupFile);
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });

  let previous = null;
  if (existsSync(dbPath)) {
    // 先 checkpoint 把 WAL 併回主檔，讓保留下來的舊檔是完整的單一檔案
    const cur = new Database(dbPath, { fileMustExist: true });
    try {
      cur.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      cur.close();
    }
    previous = `${dbPath}.before-restore-${timestamp(now)}`;
    renameSync(dbPath, previous);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(dbPath + suffix, { force: true });

  const tmp = `${dbPath}.restoring`;
  copyFileSync(backupFile, tmp);
  renameSync(tmp, dbPath);
  return { previous };
}

// ── 自我測試 ─────────────────────────────────────────────
function snapshot(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT id, title, n FROM items ORDER BY id')
      .all()
      .map((r) => `${r.id}|${r.title}|${r.n}`)
      .join('\n');
  } finally {
    db.close();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`自我測試失敗：${msg}`);
  console.log(`  ✓ ${msg}`);
}

export function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-sheets-backup-'));
  let live;
  try {
    const dbPath = join(dir, 'data', 'app.db');
    const outDir = join(dir, 'backups');
    mkdirSync(dirname(dbPath), { recursive: true });

    // 模擬運行中的服務：WAL 模式、連線保持開啟、資料尚未 checkpoint
    live = new Database(dbPath);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, n INTEGER NOT NULL)');
    const ins = live.prepare('INSERT INTO items (title, n) VALUES (?, ?)');
    live.transaction(() => {
      for (let i = 0; i < 500; i++) ins.run(`任務 ${i}`, i * 7);
    })();
    assert(existsSync(`${dbPath}-wal`), '資料仍在 WAL 中（模擬服務運行中）');
    const expected = live
      .prepare('SELECT id, title, n FROM items ORDER BY id')
      .all()
      .map((r) => `${r.id}|${r.title}|${r.n}`)
      .join('\n');

    // 備份三次（保留 2 份）
    const t0 = new Date(2026, 0, 1, 3, 0, 0);
    const b1 = backup({ dbPath, outDir, keep: 2, now: t0 });
    assert(snapshot(b1.file) === expected, '第一份備份內容與服務中資料一致（含 WAL 內容）');
    live.prepare('UPDATE items SET n = -1 WHERE id = 1').run(); // 備份後的異動，還原後應消失
    const b2 = backup({ dbPath, outDir, keep: 2, now: new Date(t0.getTime() + 86_400_000) });
    const b3 = backup({ dbPath, outDir, keep: 2, now: new Date(t0.getTime() + 2 * 86_400_000) });
    assert(b3.removed.length === 1 && b3.removed[0] === b1.file, '超過保留份數時刪除最舊的備份');
    assert(listBackups(dbPath, outDir).length === 2, '備份目錄只保留 2 份');
    // b1 已被清除；以 b2（含 id=1 的 n=-1）驗證還原
    const keptCopy = b2.file;

    // 服務停止後還原
    live.prepare('DELETE FROM items WHERE id > 100').run();
    live.close();
    const { previous } = restore({ backupFile: keptCopy, dbPath });
    assert(previous !== null && existsSync(previous), '還原前保留原資料庫');
    const restored = snapshot(dbPath);
    const expectedB2 = expected.replace(/^1\|任務 0\|0$/m, '1|任務 0|-1');
    assert(restored === expectedB2, '還原後資料與備份一致（500 筆，含備份前最後異動）');
    integrityCheck(dbPath);
    assert(true, '還原後資料庫 integrity_check = ok');

    // 還原後可正常以 WAL 模式繼續寫入
    const after = new Database(dbPath);
    after.pragma('journal_mode = WAL');
    after.prepare('INSERT INTO items (title, n) VALUES (?, ?)').run('還原後新增', 1);
    assert(after.prepare('SELECT COUNT(*) c FROM items').get().c === 501, '還原後可繼續寫入');
    after.close();
    console.log('自我測試通過');
  } finally {
    if (live?.open) live.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── CLI ──────────────────────────────────────────────────
function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const usage =
    '用法：\n' +
    '  node scripts/backup.mjs [--db <資料庫>] [--out <備份目錄>] [--keep <保留份數>]\n' +
    '  node scripts/backup.mjs restore <備份檔> [--db <資料庫>] --yes\n' +
    '  node scripts/backup.mjs --self-test';
  if (values.help) return console.log(usage);
  if (values['self-test']) return selfTest();

  const env = (k) => (process.env[k] ? process.env[k] : undefined);
  const dbPath = values.db ?? env('DATABASE_PATH') ?? 'data/app.db';

  if (positionals[0] === 'restore') {
    const backupFile = positionals[1];
    if (!backupFile) throw new Error(`缺少備份檔\n${usage}`);
    if (!values.yes) {
      throw new Error(`還原會覆蓋 ${dbPath}。請先停止服務，確認後加上 --yes 再執行。`);
    }
    const { previous } = restore({ backupFile, dbPath });
    console.log(`[restore] 已用 ${backupFile} 還原 ${dbPath}`);
    if (previous) console.log(`[restore] 原資料庫保留為 ${previous}（確認無誤後可刪除）`);
    return;
  }
  if (positionals.length > 0) throw new Error(`未知的參數：${positionals.join(' ')}\n${usage}`);

  const outDir = values.out ?? env('BACKUP_DIR') ?? 'backups';
  const keep = Number(values.keep ?? env('BACKUP_KEEP') ?? 14);
  const { file, removed } = backup({ dbPath, outDir, keep });
  console.log(`[backup] ${dbPath} → ${file}`);
  for (const f of removed) console.log(`[backup] 已刪除超過保留份數的舊備份：${f}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[backup] 錯誤：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
