#!/usr/bin/env node
// 在「各人自己的電腦」執行：讀取本機 repo 的 `git worktree list`，連同 dirty / ahead / behind / 是否已併入 main，
// 回報給 server 集中保存（POST /api/eng/worktrees/report）。server 端不執行任何 git 指令；
// 頁面上與手動紀錄的比對（可能遺失 / 未登記）只是參考提示。
//
// 用法：
//   node scripts/report-worktrees.mjs --server https://tasks.example.com [--path <repo 路徑>] [--machine <電腦名稱>] [--repo <repo 名稱>] [--dry-run]
// 環境變數：
//   WORKTREE_REPORT_TOKEN  回報 token（與 server 的設定相同；回報端點免登入，只以此 token 驗證）
//   GIT_TIMEOUT_MS         git 指令逾時（預設 10000）
// 只依賴 Node 內建模組，可單獨複製到其他電腦使用。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, posix, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    path: { type: 'string', default: '.' },
    machine: { type: 'string' },
    repo: { type: 'string' },
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
    '用法：node scripts/report-worktrees.mjs --server <網址> [--path <repo 路徑>] [--machine <電腦名稱>] [--repo <repo 名稱>] [--dry-run]',
  );
  process.exit(0);
}

const timeoutMs = Number(process.env.GIT_TIMEOUT_MS) || 10_000;

/** 以參數陣列執行 git（不經 shell）、有逾時 */
const git = (args) =>
  new Promise((done, reject) => {
    execFile(
      'git',
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new Error('找不到 git 執行檔'));
          if (err.killed) return reject(new Error(`git 執行逾時（${timeoutMs}ms）`));
          return reject(
            new Error(
              String(stderr || err.message)
                .trim()
                .split('\n')[0] || 'git 執行失敗',
            ),
          );
        }
        done(stdout);
      },
    );
  });

const normalizePath = (p) => {
  let n = posix.normalize(p.trim().replace(/\\/g, '/'));
  if (n.length > 1 && n.endsWith('/') && !/^[a-zA-Z]:\/$/.test(n)) n = n.slice(0, -1);
  return n;
};

/** 解析 `git worktree list --porcelain`（區塊以空行分隔） */
function parsePorcelain(text) {
  const entries = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) entries.push(cur);
      cur = { path: normalizePath(value), head: null, branch: null, bare: false, prunable: false };
    } else if (cur) {
      if (key === 'HEAD') cur.head = value || null;
      else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'prunable') cur.prunable = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

async function baseBranch(repo) {
  for (const name of ['main', 'master']) {
    try {
      await git(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return name;
    } catch {
      // 試下一個
    }
  }
  return null;
}

/** 分支是否曾有自己的變動（區分「已併入 main」與「剛建立尚未提交」，兩者 ahead 皆為 0） */
async function hasOwnHistory(repo, branch) {
  try {
    const out = await git(['-C', repo, 'reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--']);
    const lines = out.split(/\r?\n/).filter(Boolean);
    return lines.length === 0 || lines.some((l) => !l.startsWith('branch: Created from'));
  } catch {
    return true;
  }
}

async function detect(repo) {
  const entries = parsePorcelain(await git(['-C', repo, 'worktree', 'list', '--porcelain']));
  const base = await baseBranch(repo);
  // 第一個項目為主工作目錄（或 bare repo），不列入
  const targets = entries.slice(1).filter((e) => !e.bare);
  return Promise.all(
    targets.map(async (e) => {
      const head = e.head && /^[0-9a-f]{7,64}$/.test(e.head) ? e.head : null;
      const isPrunable = e.prunable || !existsSync(e.path);
      const w = {
        path: e.path,
        branch: e.branch,
        headSha: head,
        isDirty: false,
        ahead: null,
        behind: null,
        lastCommitAt: null,
        isPrunable,
        isMerged: false,
      };
      if (!head) return w;
      if (!isPrunable) {
        w.isDirty = (await git(['-C', e.path, 'status', '--porcelain'])).trim().length > 0;
      }
      const ct = Number((await git(['-C', repo, 'log', '-1', '--format=%ct', head])).trim());
      w.lastCommitAt = Number.isFinite(ct) && ct > 0 ? ct * 1000 : null;
      if (base) {
        const out = await git([
          '-C',
          repo,
          'rev-list',
          '--left-right',
          '--count',
          `refs/heads/${base}...${head}`,
        ]);
        const [behind, ahead] = out.trim().split(/\s+/).map(Number);
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          w.ahead = ahead;
          w.behind = behind;
          if (e.branch && e.branch !== base) {
            w.isMerged = ahead === 0 && (await hasOwnHistory(repo, e.branch));
          }
        }
      }
      return w;
    }),
  );
}

const repoPath = resolve(values.path);
if (!existsSync(repoPath)) fail(`找不到 repo 路徑：${repoPath}`);
let worktrees;
let repoName = values.repo;
try {
  if (!repoName) repoName = basename((await git(['-C', repoPath, 'rev-parse', '--show-toplevel'])).trim());
  worktrees = await detect(repoPath);
} catch (err) {
  fail(`讀取 worktree 失敗：${err.message}`);
}

const body = { machine: values.machine ?? hostname(), repo: repoName, worktrees };

if (values['dry-run']) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

if (!values.server) fail('請以 --server 指定 server 網址');
const token = process.env.WORKTREE_REPORT_TOKEN;
if (!token) fail('請設定環境變數 WORKTREE_REPORT_TOKEN');
const server = values.server.replace(/\/$/, '');

let res;
try {
  res = await fetch(`${server}/api/eng/worktrees/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Token': token },
    body: JSON.stringify(body),
  });
} catch (err) {
  fail(`無法連線 server：${err.message}`);
}
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
console.log(
  `[report-worktrees] 已回報 ${data.count} 個 worktree（電腦 ${data.machine}，repo ${data.repo || '—'}）`,
);
