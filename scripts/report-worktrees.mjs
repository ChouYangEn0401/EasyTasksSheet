#!/usr/bin/env node
// 模式 B：在開發機偵測 repo 的 worktree 狀態，回報給 server（POST /api/eng/worktrees/report）。
// 偵測邏輯與 server 共用 src/server/features/eng/detect.ts（需 Node >= 22.18，可直接載入 .ts）。
//
// 用法：
//   node scripts/report-worktrees.mjs --server https://tasks.example.com --repo tasks-sheets [--path <repo 路徑>] [--reporter <名稱>] [--dry-run]
// 環境變數：
//   WORKTREE_REPORT_TOKEN  回報 token（與 server 的 .env 相同）
//   REPORT_USERNAME / REPORT_PASSWORD  用來登入的帳號（目前 API 皆需登入 session）
//   GIT_TIMEOUT_MS  git 指令逾時（預設 10000）
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { detectWorktrees } from '../src/server/features/eng/detect.ts';

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    repo: { type: 'string' },
    path: { type: 'string', default: '.' },
    reporter: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(message) {
  console.error(`[report-worktrees] ${message}`);
  process.exit(1);
}

if (values.help) {
  console.log(
    '用法：node scripts/report-worktrees.mjs --server <網址> --repo <repo 名稱或 id> [--path <repo 路徑>] [--reporter <名稱>] [--dry-run]',
  );
  process.exit(0);
}
if (!values.repo) fail('請以 --repo 指定 server 上登記的 repo 名稱或 id');

const repoPath = resolve(values.path);
const timeoutMs = Number(process.env.GIT_TIMEOUT_MS) || 10_000;
let result;
try {
  result = await detectWorktrees(repoPath, { timeoutMs });
} catch (err) {
  fail(`偵測失敗：${err.message}`);
}

const body = {
  ...(/^\d+$/.test(values.repo) ? { repoId: Number(values.repo) } : { repo: values.repo }),
  reporter: values.reporter ?? hostname(),
  worktrees: result.worktrees,
};

if (values['dry-run']) {
  console.log(JSON.stringify({ baseBranch: result.baseBranch, ...body }, null, 2));
  process.exit(0);
}

if (!values.server) fail('請以 --server 指定 server 網址');
const token = process.env.WORKTREE_REPORT_TOKEN;
if (!token) fail('請設定環境變數 WORKTREE_REPORT_TOKEN');
const server = values.server.replace(/\/$/, '');

/** 登入取得 session cookie */
async function login() {
  const username = process.env.REPORT_USERNAME;
  const password = process.env.REPORT_PASSWORD;
  if (!username || !password) fail('請設定環境變數 REPORT_USERNAME 與 REPORT_PASSWORD');
  const res = await fetch(`${server}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) fail(`登入失敗（HTTP ${res.status}）`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) fail('登入回應沒有 session cookie');
  return cookie;
}

try {
  const cookie = await login();
  const res = await fetch(`${server}/api/eng/worktrees/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Token': token, Cookie: cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error?.message ?? text;
    } catch {
      // 非 JSON
    }
    fail(`回報失敗（HTTP ${res.status}）：${message}`);
  }
  const data = JSON.parse(text);
  console.log(`[report-worktrees] 已回報 ${data.count} 個 worktree（repo #${data.repoId}）`);
} catch (err) {
  fail(`無法連線 server：${err.message}`);
}
