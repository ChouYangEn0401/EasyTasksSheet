import { asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Change } from '../../../shared/sync.ts';
import { changes, sessions, users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { readQuery } from '../../lib/validate.ts';
import { changesSince, hubFor, latestChangeId, syncOptions } from './hub.ts';

/** GET /api/changes 的回應（前端 lib/sync.ts 有對應型別） */
export type ChangesResponse = {
  changes: Change[];
  /** 本批最後一筆的 id（無變更時為目前最新 id）；下次以此為 since */
  latestId: number;
  /** 超過單次上限，還有更多（前端應改為全部重抓） */
  hasMore: boolean;
  /** since 之後有流水已被清除，無法完整補漏（前端應全部重抓） */
  reset: boolean;
};

const sinceQuery = z.object({ since: z.coerce.number().int().min(0).optional() });

function firstChangeId(c: Context<AppEnv>): number | undefined {
  return c.var.db.select({ id: changes.id }).from(changes).orderBy(asc(changes.id)).limit(1).get()?.id;
}

/** 取 since 之後的流水；since 未給時只回 latestId（用來取得起點） */
function readChanges(c: Context<AppEnv>, since: number | undefined): ChangesResponse {
  const { db } = c.var;
  const latestId = latestChangeId(db);
  if (since == null || since >= latestId) return { changes: [], latestId, hasMore: false, reset: false };
  const first = firstChangeId(c);
  const reset = first != null && since < first - 1;
  const rows = changesSince(db, since, syncOptions.maxBatch + 1);
  const hasMore = rows.length > syncOptions.maxBatch;
  const list = hasMore ? rows.slice(0, syncOptions.maxBatch) : rows;
  return { changes: list, latestId: hasMore ? list[list.length - 1]!.id : latestId, hasMore, reset };
}

/** 掛載於 /api/changes：GET ?since=<id>（SSE 斷線補漏、輪詢後備） */
export const changesRoutes = new Hono<AppEnv>().get('/', (c) => {
  const { since } = readQuery(c, sinceQuery);
  return c.json(readChanges(c, since));
});

/** SSE 連線期間 session 是否仍有效（GET 不刷新閒置計時，所以逾時後會被斷開） */
function sessionStillValid(c: Context<AppEnv>): boolean {
  const { db, now, settings } = c.var;
  const s = db.select().from(sessions).where(eq(sessions.id, c.var.session.id)).get();
  if (!s) return false;
  const t = now();
  if (t >= s.expiresAt || t - s.lastActiveAt >= settings.idleTimeoutMs) return false;
  const u = db.select({ isActive: users.isActive }).from(users).where(eq(users.id, s.userId)).get();
  return !!u?.isActive;
}

/**
 * 掛載於 /api/events：SSE。
 * - 連線時送 `ready`（data: { latestId, reset }）；若帶 ?since= 或 Last-Event-ID，先重播其後的流水
 *   （無法完整重播時 reset = true，前端應全部重抓）
 * - 每筆變更送 `change`（id = change id，data = Change JSON）
 * - 每 heartbeatMs 送 `ping` 心跳，並重新檢查 session；失效時送 `expired` 後關閉
 * - 本連線屬 GET，不刷新閒置計時（requireSession 只對非 GET 刷新）
 */
export const eventsRoutes = new Hono<AppEnv>().get('/', (c) => {
  const { since: sinceParam } = readQuery(c, sinceQuery);
  const lastEventId = Number(c.req.header('last-event-id'));
  const since = Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : sinceParam;
  const { db } = c.var;

  const res = streamSSE(c, async (stream) => {
    let sent = 0;
    let ready = false;
    let closed = false;
    let wake: (() => void) | null = null;
    const pending: Change[] = [];

    const send = async (rows: Change[]) => {
      for (const row of rows) {
        if (row.id <= sent || closed) continue;
        sent = row.id;
        await stream.writeSSE({ event: 'change', id: String(row.id), data: JSON.stringify(row) });
      }
    };

    // 先訂閱再重播（皆為同步查詢，不會漏；send 以 sent 過濾重複）
    const unsubscribe = hubFor(db).subscribe((rows) => {
      if (ready) void send(rows);
      else pending.push(...rows);
    });
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });

    try {
      const latestId = latestChangeId(db);
      const replay = since != null ? readChanges(c, since) : null;
      const complete = !!replay && !replay.reset && !replay.hasMore;
      await stream.writeSSE({
        event: 'ready',
        data: JSON.stringify({ latestId, reset: !!replay && !complete }),
        retry: 3000,
      });
      if (complete) {
        sent = since!;
        await send(replay.changes);
      } else sent = latestId;
      ready = true;
      await send(pending.splice(0));

      while (!closed) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, syncOptions.heartbeatMs);
          t.unref?.();
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
        if (closed) break;
        if (!sessionStillValid(c)) {
          await stream.writeSSE({ event: 'expired', data: '{}' });
          break;
        }
        // 以具名事件送心跳（前端可據此偵測半開連線；EventSource 看不到註解行）
        await stream.writeSSE({ event: 'ping', data: '' });
      }
    } finally {
      unsubscribe();
    }
  });
  // 代理（Caddy / nginx）不得緩衝或壓縮此回應（streamSSE 會覆寫 Cache-Control，故事後設定）
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
});
