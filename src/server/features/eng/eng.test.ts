import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { client, loginAs } from '../../../../tests/helpers/auth.ts';
import {
  createFakeClock,
  createTempDbFile,
  createTestApp,
  createTestUser,
} from '../../../../tests/helpers/db.ts';
import type { GitIssue, IssuesResponse, WorktreesResponse } from '../../../shared/eng.ts';
import { createApp } from '../../app.ts';
import { createDb } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { runSeed } from '../../db/seed.ts';
import { changes, tasks } from '../../db/schema.ts';
import { createGitFixture } from './gitFixture.ts';
import { createGitHubIssueSource, IssueSourceError, type IssueSource } from './issueSource.ts';
import { configureEng } from './settings.ts';

const MINUTE = 60_000;

async function setup(start?: number) {
  const clock = createFakeClock(start);
  const { app, db } = createTestApp({ now: clock.now });
  const admin = await createTestUser(db, { role: 'admin', displayName: 'Admin' });
  const alice = await createTestUser(db, { displayName: 'Alice' });
  const ad = await loginAs(app, admin);
  const a = await loginAs(app, alice);
  const changeRows = () => db.select().from(changes).all();
  const createRepo = async (body: Record<string, unknown>) => {
    const res = await ad.request('POST', '/api/eng/repos', body);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; localPath: string | null };
  };
  return { app, db, clock, admin, alice, ad, a, changeRows, createRepo };
}

/** 可控制的 mock issue 來源 */
function mockSource(initial: GitIssue[] = []) {
  const state = { issues: initial, calls: 0, fail: null as string | null, configured: true };
  const source: IssueSource = {
    name: 'mock',
    isConfigured: () => state.configured,
    listOpenIssues: async () => {
      state.calls += 1;
      if (state.fail) throw new IssueSourceError(state.fail);
      return state.issues;
    },
  };
  return { state, source };
}

const issue = (n: number, updated: number, extra: Partial<GitIssue> = {}): GitIssue => ({
  number: n,
  title: `Issue ${n}`,
  labels: ['bug'],
  assignee: 'octocat',
  url: `https://github.com/o/r/issues/${n}`,
  issueUpdatedAt: updated,
  ...extra,
});

afterEach(() => configureEng());

describe('/api/eng/repos', () => {
  it('未登入 401；所有成員可讀；只有管理員可新增 / 編輯 / 刪除，且記錄變更', async () => {
    const { app, a, ad, admin, changeRows } = await setup();
    expect((await client(app).get('/api/eng/repos')).status).toBe(401);
    expect((await a.request('POST', '/api/eng/repos', { name: 'x' })).status).toBe(403);

    const res = await ad.request('POST', '/api/eng/repos', {
      name: ' tasks-sheets ',
      localPath: '',
      remoteSlug: 'acme/tasks-sheets',
    });
    expect(res.status).toBe(201);
    const repo = await res.json();
    expect(repo).toMatchObject({ name: 'tasks-sheets', localPath: null, remoteSlug: 'acme/tasks-sheets' });
    expect((await ad.request('POST', '/api/eng/repos', { name: 'y', remoteSlug: 'not a slug' })).status).toBe(
      400,
    );

    expect(await (await a.get('/api/eng/repos')).json()).toHaveLength(1);
    expect((await a.request('PATCH', `/api/eng/repos/${repo.id}`, { name: 'z' })).status).toBe(403);
    const patched = await ad.request('PATCH', `/api/eng/repos/${repo.id}`, { name: 'renamed' });
    expect(await patched.json()).toMatchObject({ name: 'renamed' });
    expect((await a.request('DELETE', `/api/eng/repos/${repo.id}`)).status).toBe(403);
    expect((await ad.request('DELETE', `/api/eng/repos/${repo.id}`)).status).toBe(200);
    expect((await ad.request('DELETE', `/api/eng/repos/${repo.id}`)).status).toBe(404);
    expect(changeRows()).toMatchObject([
      { entityType: 'repo', entityId: repo.id, action: 'create', actorId: admin.id },
      { entityType: 'repo', entityId: repo.id, action: 'update', actorId: admin.id },
      { entityType: 'repo', entityId: repo.id, action: 'delete', actorId: admin.id },
    ]);
  });
});

describe('/api/eng/worktree-plans', () => {
  it('成員可新增 / 編輯 / 刪除安排；驗證外鍵與同 repo 路徑重複；記錄變更', async () => {
    const { a, db, alice, changeRows, createRepo } = await setup();
    const repo = await createRepo({ name: 'r', localPath: '/srv/repo' });
    const task = db.insert(tasks).values({ title: 'T', projectId: 1, statusId: 1 }).returning().get();

    const res = await a.request('POST', '/api/eng/worktree-plans', {
      repoId: repo.id,
      branch: 'feat/a',
      path: '../wt-a',
      ownerId: alice.id,
      taskId: task.id,
      purpose: '開發 A',
    });
    expect(res.status).toBe(201);
    const plan = await res.json();
    expect(plan).toMatchObject({ branch: 'feat/a', ownerId: alice.id, taskId: task.id, purpose: '開發 A' });

    // 同一路徑（絕對 / 相對寫法皆視為相同）
    const dup = await a.request('POST', '/api/eng/worktree-plans', {
      repoId: repo.id,
      branch: 'feat/b',
      path: '/srv/wt-a/',
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({
      error: { message: '此路徑已有安排', details: { field: 'path' } },
    });

    const bad = (body: Record<string, unknown>) =>
      a.request('POST', '/api/eng/worktree-plans', { repoId: repo.id, branch: 'b', path: 'p', ...body });
    expect((await bad({ ownerId: 999 })).status).toBe(400);
    expect((await bad({ taskId: 999 })).status).toBe(400);
    expect((await bad({ repoId: 999 })).status).toBe(400);
    expect((await bad({ purpose: 'x'.repeat(201) })).status).toBe(400);
    expect((await bad({ branch: ' ' })).status).toBe(400);

    const upd = await a.request('PATCH', `/api/eng/worktree-plans/${plan.id}`, {
      ownerId: null,
      purpose: '',
    });
    expect(await upd.json()).toMatchObject({ ownerId: null, purpose: '', branch: 'feat/a' });
    const list = await (await a.get(`/api/eng/worktree-plans?repo=${repo.id}`)).json();
    expect(list).toHaveLength(1);
    expect((await a.request('DELETE', `/api/eng/worktree-plans/${plan.id}`)).status).toBe(200);
    expect((await a.request('DELETE', `/api/eng/worktree-plans/${plan.id}`)).status).toBe(404);

    expect(changeRows().filter((c) => c.entityType === 'worktree_plan')).toMatchObject([
      { entityId: plan.id, action: 'create', actorId: alice.id },
      { entityId: plan.id, action: 'update', actorId: alice.id },
      { entityId: plan.id, action: 'delete', actorId: alice.id },
    ]);
  });
});

describe('/api/eng/issues（mock 來源）', () => {
  it('未設定 token：configured=false，不呼叫來源', async () => {
    const { a, createRepo } = await setup();
    const { state, source } = mockSource([issue(1, 1)]);
    state.configured = false;
    configureEng({ issueSource: source });
    const repo = await createRepo({ name: 'r', remoteSlug: 'o/r' });
    const body: IssuesResponse = await (await a.get(`/api/eng/issues?repo=${repo.id}`)).json();
    expect(body).toMatchObject({ configured: false, issues: [], fetchedAt: null, error: null });
    expect(state.calls).toBe(0);
  });

  it('未設定 remote_slug：回傳空清單且 remoteSlug=null', async () => {
    const { a, createRepo } = await setup();
    const { state, source } = mockSource();
    configureEng({ issueSource: source });
    const repo = await createRepo({ name: 'r' });
    const body = await (await a.get(`/api/eng/issues?repo=${repo.id}`)).json();
    expect(body).toMatchObject({ configured: true, remoteSlug: null, issues: [] });
    expect(state.calls).toBe(0);
  });

  it('快取 5 分鐘、手動重新整理強制同步、依更新時間新到舊；失敗時保留快取並回報錯誤', async () => {
    const { a, clock, createRepo, changeRows } = await setup();
    const t0 = clock.now();
    const { state, source } = mockSource([issue(1, t0 - 3 * MINUTE), issue(2, t0 - MINUTE)]);
    configureEng({ issueSource: source, issueCacheMs: 5 * MINUTE });
    const repo = await createRepo({ name: 'r', remoteSlug: 'o/r' });
    const get = async (): Promise<IssuesResponse> => (await a.get(`/api/eng/issues?repo=${repo.id}`)).json();

    let body = await get();
    expect(state.calls).toBe(1);
    expect(body.fetchedAt).toBe(t0);
    expect(body.issues.map((i) => i.number)).toEqual([2, 1]);
    expect(body.issues[0]).toMatchObject({ title: 'Issue 2', labels: ['bug'], assignee: 'octocat' });

    // 5 分鐘內使用快取
    clock.advance(4 * MINUTE);
    state.issues = [issue(3, clock.now())];
    body = await get();
    expect(state.calls).toBe(1);
    expect(body.issues).toHaveLength(2);

    // 手動重新整理
    const refreshed: IssuesResponse = await (
      await a.request('POST', '/api/eng/issues/refresh', { repoId: repo.id })
    ).json();
    expect(state.calls).toBe(2);
    expect(refreshed.issues.map((i) => i.number)).toEqual([3]);
    expect(refreshed.fetchedAt).toBe(clock.now());
    expect(changeRows().filter((c) => c.entityType === 'repo' && c.action === 'update')).toHaveLength(1);

    // 失敗：保留快取並帶 error；失敗後同樣 5 分鐘內不自動重試
    clock.advance(6 * MINUTE);
    state.fail = 'GitHub 回應錯誤：HTTP 500';
    body = await get();
    expect(state.calls).toBe(3);
    expect(body.issues.map((i) => i.number)).toEqual([3]);
    expect(body.error).toMatchObject({ message: 'GitHub 回應錯誤：HTTP 500' });
    expect((await get()).issues).toHaveLength(1);
    expect(state.calls).toBe(3);

    // 恢復後手動重新整理清除錯誤
    state.fail = null;
    state.issues = [];
    body = await (await a.request('POST', '/api/eng/issues/refresh', { repoId: repo.id })).json();
    expect(body).toMatchObject({ error: null, issues: [] });
    expect(body.fetchedAt).toBe(clock.now());
  });

  it('不存在的 repo 回 404', async () => {
    const { a } = await setup();
    expect((await a.get('/api/eng/issues?repo=999')).status).toBe(404);
  });
});

describe('GitHub issue 來源', () => {
  it('帶 token 呼叫 REST、排除 PR、跟隨同源分頁', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchMock = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      const page2 = 'https://api.github.test/repos/o/r/issues?page=2';
      if (url === page2) {
        return Response.json([
          { number: 3, title: 'c', html_url: 'u3', updated_at: null, labels: [], assignee: null },
        ]);
      }
      return Response.json(
        [
          {
            number: 1,
            title: 'a',
            html_url: 'u1',
            updated_at: '2026-01-01T00:00:00Z',
            labels: [{ name: 'bug' }, 'docs'],
            assignee: { login: 'me' },
          },
          {
            number: 2,
            title: 'pr',
            html_url: 'u2',
            updated_at: null,
            labels: [],
            assignee: null,
            pull_request: {},
          },
        ],
        { headers: { link: `<${page2}>; rel="next", <https://evil.test/x>; rel="last"` } },
      );
    };
    const src = createGitHubIssueSource({
      token: 't0k',
      apiUrl: 'https://api.github.test/',
      fetch: fetchMock,
    });
    expect(src.isConfigured()).toBe(true);
    const items = await src.listOpenIssues('o/r');
    expect(items.map((i) => i.number)).toEqual([1, 3]);
    expect(items[0]).toMatchObject({
      labels: ['bug', 'docs'],
      assignee: 'me',
      issueUpdatedAt: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(calls[0]!.url).toBe(
      'https://api.github.test/repos/o/r/issues?state=open&per_page=100&sort=updated&direction=desc',
    );
    expect(calls.every((c) => c.auth === 'Bearer t0k')).toBe(true);

    const unauth = createGitHubIssueSource({
      token: 'x',
      apiUrl: 'https://api.github.test',
      fetch: async () => new Response('{}', { status: 401 }),
    });
    await expect(unauth.listOpenIssues('o/r')).rejects.toThrow('token 無效');
    expect(createGitHubIssueSource({ token: undefined, apiUrl: 'x' }).isConfigured()).toBe(false);
  });
});

describe('/api/eng/worktrees', () => {
  const fx = createGitFixture();
  beforeAll(() => {
    fx.scenario(Date.now());
  });
  afterAll(() => fx.cleanup());

  it('模式 A：server 偵測已登記的 repo 路徑並對照安排', async () => {
    const { a, clock, createRepo } = await setup(Date.now());
    const repo = await createRepo({ name: 'fixture', localPath: fx.repo });
    const plan = async (branch: string, path: string) =>
      expect(
        (await a.request('POST', '/api/eng/worktree-plans', { repoId: repo.id, branch, path })).status,
      ).toBe(201);
    await plan('feat/ok', '../wt-ok');
    await plan('feat/merged', '../wt-merged');
    await plan('feat/dirty', '../wt-dirty');
    await plan('feat/stale', '../wt-stale');
    await plan('feat/gone', '../wt-gone');

    const res = await a.get(`/api/eng/worktrees?repo=${repo.id}`);
    expect(res.status).toBe(200);
    const body: WorktreesResponse = await res.json();
    expect(body.mode).toBe('local');
    expect(body.detectedAt).toBe(clock.now());
    const map = Object.fromEntries(body.rows.map((r) => [r.branch, [r.status, ...r.flags].join('+')]));
    expect(map).toEqual({
      'feat/gone': 'missing',
      'tmp/spike': 'unplanned',
      'feat/fresh': 'unplanned',
      'feat/merged': 'merged',
      'feat/dirty': 'ok+dirty',
      'feat/stale': 'ok+stale',
      'feat/ok': 'ok',
    });
    expect(body.rows[0]!.status).toBe('missing');
    const spike = body.rows.find((r) => r.branch === 'tmp/spike')!;
    expect(spike.snapshot).toMatchObject({ reportedBy: 'server', ahead: 1, isMerged: false });
    const merged = body.rows.find((r) => r.branch === 'feat/merged')!;
    expect(merged.snapshot).toMatchObject({ ahead: 0, isMerged: true });
  });

  it('偵測失敗回 502 與訊息', async () => {
    const { a, createRepo } = await setup();
    configureEng({
      detect: async () => {
        throw new Error('git 執行逾時（10ms）');
      },
    });
    const repo = await createRepo({ name: 'fixture', localPath: fx.repo });
    const res = await a.get(`/api/eng/worktrees?repo=${repo.id}`);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('逾時');
  });

  it('模式 B：回報端點免 session、僅以 token 驗證，整批取代實際狀態並記錄變更', async () => {
    const { a, app, createRepo, changeRows } = await setup();
    const repo = await createRepo({ name: 'remote-repo', localPath: 'D:/dev/remote-repo-not-on-server' });
    const report = {
      repo: 'remote-repo',
      reporter: 'alice-pc',
      worktrees: [
        {
          path: 'D:\\dev\\wt-a',
          branch: 'feat/a',
          headSha: 'abcdef1234567',
          isDirty: true,
          ahead: 2,
          behind: 1,
          lastCommitAt: Date.now(),
          isPrunable: false,
        },
      ],
    };
    const countBefore = changeRows().length;
    // 腳本式請求：無 cookie、無 Origin
    const post = (headers: Record<string, string>, body: unknown = report) =>
      app.request('http://localhost/api/eng/worktrees/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    // token 未設定：一律拒絕（即使帶了 token 或已登入）
    expect((await post({ 'x-report-token': 'anything' })).status).toBe(403);
    expect(
      (await a.request('POST', '/api/eng/worktrees/report', report, { 'x-report-token': 'anything' })).status,
    ).toBe(403);

    configureEng({ reportToken: 'secret-token' });
    // 無 token / 錯誤 token
    expect((await post({})).status).toBe(403);
    expect((await post({ 'x-report-token': 'wrong' })).status).toBe(403);
    expect((await post({ authorization: 'Bearer secret-token-x' })).status).toBe(403);
    // 已登入但沒帶 token 也不行（session 不能取代 token）
    expect((await a.request('POST', '/api/eng/worktrees/report', report)).status).toBe(403);
    // CSRF：仍須 application/json；帶 Origin 時須同源
    const wrongType = await app.request('http://localhost/api/eng/worktrees/report', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-report-token': 'secret-token' },
      body: JSON.stringify(report),
    });
    expect(wrongType.status).toBe(403);
    expect((await post({ 'x-report-token': 'secret-token', origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect(changeRows()).toHaveLength(countBefore);

    // 有效 token：免登入即可回報（X-Report-Token 或 Bearer 皆可）
    expect((await post({ 'x-report-token': 'secret-token' })).status).toBe(200);
    const ok = await post({ authorization: 'Bearer secret-token' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, repoId: repo.id, count: 1 });
    expect(changeRows().at(-1)).toMatchObject({ entityType: 'repo', entityId: repo.id, actorId: null });
    // 同源瀏覽器請求亦可
    expect(
      (
        await client(app).request('POST', '/api/eng/worktrees/report', report, {
          'x-report-token': 'secret-token',
        })
      ).status,
    ).toBe(200);

    await a.request('POST', '/api/eng/worktree-plans', {
      repoId: repo.id,
      branch: 'feat/a',
      path: '../wt-a',
    });
    const body: WorktreesResponse = await (await a.get(`/api/eng/worktrees?repo=${repo.id}`)).json();
    expect(body.mode).toBe('report');
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ status: 'ok', flags: ['dirty'], path: 'D:/dev/wt-a' });
    expect(body.rows[0]!.snapshot).toMatchObject({ reportedBy: 'alice-pc' });

    const missingRepo = await a.request(
      'POST',
      '/api/eng/worktrees/report',
      { ...report, repo: 'nope' },
      { 'x-report-token': 'secret-token' },
    );
    expect(missingRepo.status).toBe(404);
  });

  it('「已併入」判定持久化：server 重啟後仍區分剛建立未提交與已合併未清理', async () => {
    const tmp = createTempDbFile();
    try {
      configureEng({ reportToken: 'secret-token' });
      const db1 = createDb(tmp.path);
      runMigrations(db1);
      runSeed(db1);
      const user = await createTestUser(db1, { role: 'admin' });
      const app1 = createApp({ db: db1 });
      const u1 = await loginAs(app1, user);
      const repoRes = await u1.request('POST', '/api/eng/repos', { name: 'remote-repo' });
      const repo = (await repoRes.json()) as { id: number };
      const wt = (branch: string, isMerged?: boolean) => ({
        path: `/dev/wt-${branch.replace('/', '-')}`,
        branch,
        headSha: 'abcdef1234567',
        isDirty: false,
        ahead: 0,
        behind: 1,
        lastCommitAt: Date.now(),
        isPrunable: false,
        ...(isMerged !== undefined && { isMerged }),
      });
      for (const branch of ['feat/merged', 'feat/fresh', 'feat/unknown']) {
        const p = wt(branch).path;
        expect(
          (await u1.request('POST', '/api/eng/worktree-plans', { repoId: repo.id, branch, path: p })).status,
        ).toBe(201);
      }
      const res = await app1.request('http://localhost/api/eng/worktrees/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-report-token': 'secret-token' },
        body: JSON.stringify({
          repoId: repo.id,
          worktrees: [wt('feat/merged', true), wt('feat/fresh', false), wt('feat/unknown')],
        }),
      });
      expect(res.status).toBe(200);
      const statuses = async (c: Awaited<ReturnType<typeof loginAs>>) => {
        const body: WorktreesResponse = await (await c.get(`/api/eng/worktrees?repo=${repo.id}`)).json();
        return Object.fromEntries(body.rows.map((r) => [r.branch, [r.status, r.snapshot?.isMerged]]));
      };
      const expected = {
        'feat/merged': ['merged', true],
        // 剛建立未提交：ahead 同為 0 但偵測端判定未併入
        'feat/fresh': ['ok', false],
        // 偵測端無法判定（省略 isMerged）：存 false
        'feat/unknown': ['ok', false],
      };
      expect(await statuses(u1)).toEqual(expected);
      db1.$client.close();

      // 模擬重啟：重新開啟 DB 檔、建立新的 app（記憶體狀態全部清空）
      const db2 = createDb(tmp.path);
      runMigrations(db2);
      const app2 = createApp({ db: db2 });
      expect(await statuses(await loginAs(app2, user))).toEqual(expected);
      db2.$client.close();
    } finally {
      tmp.cleanup();
    }
  });
});
