import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { idParam } from '../../../shared/common.ts';
import {
  issuesQuery,
  issuesRefreshInput,
  repoInput,
  repoUpdateInput,
  worktreePlanInput,
  worktreePlansQuery,
  worktreePlanUpdateInput,
  worktreeReportInput,
  worktreesQuery,
  type Repo,
} from '../../../shared/eng.ts';
import type { DbOrTx } from '../../db/client.ts';
import { gitIssuesCache, repos, tasks, users, worktreePlans, worktreeSnapshots } from '../../db/schema.ts';
import type { AppEnv, UserRow } from '../../lib/context.ts';
import { badRequest, forbidden, HttpError, notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { readJson, readQuery } from '../../lib/validate.ts';
import { pathKey, resolvePlanPath } from './detect.ts';
import { getIssues, getWorktrees, listPlans, rememberMerged, replaceSnapshots } from './service.ts';
import { clearRepoRuntime, engSettings } from './settings.ts';

const REPO_NOT_FOUND = '此 repo 不存在或已被刪除';
const PLAN_NOT_FOUND = '此安排不存在或已被刪除';

const findRepo = (db: DbOrTx, id: number): Repo | undefined =>
  db.select().from(repos).where(eq(repos.id, id)).get();

function requireRepo(db: DbOrTx, id: number): Repo {
  const r = findRepo(db, id);
  if (!r) throw notFound(REPO_NOT_FOUND);
  return r;
}

function requireAdmin(c: Context<AppEnv>) {
  if (c.var.user.role !== 'admin') throw forbidden('只有管理員可以設定 repo');
}

const findPlan = (db: DbOrTx, id: number) =>
  db.select().from(worktreePlans).where(eq(worktreePlans.id, id)).get();

/** 外鍵欄位需指向存在的資料；同 repo 內路徑不可重複 */
function checkPlan(
  db: DbOrTx,
  plan: { repoId: number; path: string; ownerId?: number | null; taskId?: number | null },
  selfId?: number,
) {
  const repo = findRepo(db, plan.repoId);
  if (!repo) throw badRequest('repo 不存在');
  if (plan.ownerId != null && !db.select().from(users).where(eq(users.id, plan.ownerId)).get()) {
    throw badRequest('負責人不存在');
  }
  if (
    plan.taskId != null &&
    !db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, plan.taskId), isNull(tasks.deletedAt)))
      .get()
  ) {
    throw badRequest('關聯任務不存在');
  }
  const key = pathKey(resolvePlanPath(repo.localPath, plan.path));
  const dup = listPlans(db, plan.repoId).some(
    (p) => p.id !== selfId && pathKey(resolvePlanPath(repo.localPath, p.path)) === key,
  );
  if (dup) throw new HttpError(409, 'CONFLICT', '此路徑已有安排', { field: 'path' });
}

const sha = (s: string) => createHash('sha256').update(s).digest();

/** 回報 token：X-Report-Token 或 Authorization: Bearer；以固定時間比較 */
function checkReportToken(c: Context<AppEnv>) {
  const expected = engSettings().reportToken;
  if (!expected) throw forbidden('伺服器未設定回報 token（WORKTREE_REPORT_TOKEN）');
  const given =
    c.req.header('x-report-token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!given || !timingSafeEqual(sha(given), sha(expected))) throw forbidden('回報 token 錯誤');
}

/**
 * 掛載於 /api/eng。
 * - repo：所有成員可讀，寫入僅管理員
 * - worktree 安排：所有成員可讀寫
 * - issues：讀快取，過期才向來源同步；refresh 強制同步
 * - worktrees：安排 × 實際狀態（模式 A 由 server 偵測；模式 B 由回報端點寫入）
 */
export const engRoutes = new Hono<AppEnv>()
  // ── repos ──
  .get('/repos', (c) => c.json(c.var.db.select().from(repos).orderBy(asc(repos.name), asc(repos.id)).all()))
  .post('/repos', async (c) => {
    requireAdmin(c);
    const { db, now, user } = c.var;
    const input = await readJson(c, repoInput);
    const row = db.transaction((tx) => {
      const t = now();
      const created = tx
        .insert(repos)
        .values({ ...input, createdAt: t, updatedAt: t })
        .returning()
        .get();
      recordChange(tx, { entityType: 'repo', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .patch('/repos/:id', async (c) => {
    requireAdmin(c);
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, repoUpdateInput);
    const row = db.transaction((tx) => {
      const current = requireRepo(tx, id);
      const updated = tx
        .update(repos)
        .set({ ...input, updatedAt: now() })
        .where(eq(repos.id, id))
        .returning()
        .get();
      // 來源或路徑變更：舊的快取與偵測結果不再適用
      if (input.remoteSlug !== undefined && input.remoteSlug !== current.remoteSlug) {
        tx.delete(gitIssuesCache).where(eq(gitIssuesCache.repoId, id)).run();
      }
      if (input.localPath !== undefined && input.localPath !== current.localPath) {
        tx.delete(worktreeSnapshots).where(eq(worktreeSnapshots.repoId, id)).run();
      }
      recordChange(tx, { entityType: 'repo', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    clearRepoRuntime(db, id);
    return c.json(row);
  })
  .delete('/repos/:id', (c) => {
    requireAdmin(c);
    const { db, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      requireRepo(tx, id);
      // 安排、實際狀態、issue 快取皆以外鍵 cascade 一併刪除
      tx.delete(repos).where(eq(repos.id, id)).run();
      recordChange(tx, { entityType: 'repo', entityId: id, action: 'delete', actorId: user.id });
    });
    clearRepoRuntime(db, id);
    return c.json({ ok: true as const });
  })

  // ── issues ──
  .get('/issues', async (c) => {
    const { db, now } = c.var;
    const { repo } = readQuery(c, issuesQuery);
    return c.json(await getIssues(db, requireRepo(db, repo), now));
  })
  .post('/issues/refresh', async (c) => {
    const { db, now, user } = c.var;
    const { repoId } = await readJson(c, issuesRefreshInput);
    const repo = requireRepo(db, repoId);
    const result = await getIssues(db, repo, now, true);
    // 快取有更新才記一筆（供即時同步通知其他人重抓）
    if (result.configured && result.remoteSlug && !result.error) {
      recordChange(db, { entityType: 'repo', entityId: repo.id, action: 'update', actorId: user.id });
    }
    return c.json(result);
  })

  // ── worktrees ──
  .get('/worktrees', async (c) => {
    const { db, now } = c.var;
    const { repo, refresh } = readQuery(c, worktreesQuery);
    return c.json(await getWorktrees(db, requireRepo(db, repo), now, refresh === '1'));
  })
  .post('/worktrees/report', async (c) => {
    checkReportToken(c);
    const { db, now } = c.var;
    // 若日後此端點改為免 session（僅 token），user 可能不存在
    const actor = c.get('user') as UserRow | undefined;
    const input = await readJson(c, worktreeReportInput);
    const repo =
      input.repoId != null
        ? findRepo(db, input.repoId)
        : db.select().from(repos).where(eq(repos.name, input.repo!)).get();
    if (!repo) throw notFound(REPO_NOT_FOUND);
    const reporter = input.reporter ?? actor?.username ?? hostname();
    const count = db.transaction((tx) => {
      const n = replaceSnapshots(tx, repo.id, input.worktrees, reporter, now());
      recordChange(tx, {
        entityType: 'repo',
        entityId: repo.id,
        action: 'update',
        actorId: actor?.id ?? null,
      });
      return n;
    });
    rememberMerged(db, repo.id, input.worktrees);
    return c.json({ ok: true as const, repoId: repo.id, count });
  })

  // ── worktree 安排 ──
  .get('/worktree-plans', (c) => {
    const { repo } = readQuery(c, worktreePlansQuery);
    const rows = c.var.db
      .select()
      .from(worktreePlans)
      .where(repo ? eq(worktreePlans.repoId, repo) : undefined)
      .orderBy(asc(worktreePlans.branch), asc(worktreePlans.id))
      .all();
    return c.json(rows);
  })
  .post('/worktree-plans', async (c) => {
    const { db, now, user } = c.var;
    const input = await readJson(c, worktreePlanInput);
    const row = db.transaction((tx) => {
      checkPlan(tx, input);
      const t = now();
      const created = tx
        .insert(worktreePlans)
        .values({ ...input, purpose: input.purpose ?? '', createdAt: t, updatedAt: t })
        .returning()
        .get();
      recordChange(tx, {
        entityType: 'worktree_plan',
        entityId: created.id,
        action: 'create',
        actorId: user.id,
      });
      return created;
    });
    return c.json(row, 201);
  })
  .get('/worktree-plans/:id', (c) => {
    const plan = findPlan(c.var.db, idParam.parse(c.req.param('id')));
    if (!plan) throw notFound(PLAN_NOT_FOUND);
    return c.json(plan);
  })
  .patch('/worktree-plans/:id', async (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, worktreePlanUpdateInput);
    const row = db.transaction((tx) => {
      const current = findPlan(tx, id);
      if (!current) throw notFound(PLAN_NOT_FOUND);
      checkPlan(tx, { ...current, ...input }, id);
      const updated = tx
        .update(worktreePlans)
        .set({ ...input, updatedAt: now() })
        .where(eq(worktreePlans.id, id))
        .returning()
        .get();
      recordChange(tx, { entityType: 'worktree_plan', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  })
  .delete('/worktree-plans/:id', (c) => {
    const { db, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      if (!findPlan(tx, id)) throw notFound(PLAN_NOT_FOUND);
      tx.delete(worktreePlans).where(eq(worktreePlans.id, id)).run();
      recordChange(tx, { entityType: 'worktree_plan', entityId: id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  });
