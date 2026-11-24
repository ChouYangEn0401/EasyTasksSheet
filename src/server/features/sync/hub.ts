import { asc, desc, gt } from 'drizzle-orm';
import type { Change } from '../../../shared/sync.ts';
import type { Db } from '../../db/client.ts';
import { changes } from '../../db/schema.ts';

/**
 * 變更廣播中心（每個 Db 一個）。
 *
 * recordChange() 屬凍結的 core lib，不能在寫入當下直接通知；因此 hub 在「有訂閱者時」
 * 以短間隔查 changes 表的新流水（id > lastId，走主鍵索引，成本極低），再推給所有 SSE 連線。
 * 沒有訂閱者時停止輪詢。同一行程內所有連線共用一次查詢。
 */

export const syncOptions = {
  /** hub 查新流水的間隔 */
  pollMs: 250,
  /** SSE 心跳間隔（避免代理 / 瀏覽器判定逾時，同時重新檢查 session） */
  heartbeatMs: 25_000,
  /** 單次補漏 / 重播的上限筆數 */
  maxBatch: 500,
};

type Listener = (rows: Change[]) => void;

const toChange = (r: typeof changes.$inferSelect): Change => ({
  id: r.id,
  entityType: r.entityType,
  entityId: r.entityId,
  action: r.action,
  actorId: r.actorId ?? null,
  createdAt: r.createdAt,
});

/** 目前最新的 change id（無流水時為 0） */
export function latestChangeId(db: Db): number {
  return db.select({ id: changes.id }).from(changes).orderBy(desc(changes.id)).limit(1).get()?.id ?? 0;
}

/** 取 id > since 的流水（依 id 遞增，最多 limit 筆） */
export function changesSince(db: Db, since: number, limit = syncOptions.maxBatch): Change[] {
  return db
    .select()
    .from(changes)
    .where(gt(changes.id, since))
    .orderBy(asc(changes.id))
    .limit(limit)
    .all()
    .map(toChange);
}

export class ChangeHub {
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastId = 0;
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get size() {
    return this.listeners.size;
  }

  subscribe(fn: Listener): () => void {
    if (this.listeners.size === 0) this.start();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** 立即檢查一次新流水（測試與計時器共用） */
  poll(): void {
    let rows: Change[];
    try {
      rows = changesSince(this.db, this.lastId);
    } catch {
      return; // DB 已關閉（測試結束）等情況：靜默略過
    }
    if (!rows.length) return;
    this.lastId = rows[rows.length - 1]!.id;
    for (const fn of [...this.listeners]) {
      try {
        fn(rows);
      } catch {
        // 單一連線出錯不影響其他連線
      }
    }
  }

  private start() {
    this.lastId = latestChangeId(this.db);
    this.timer = setInterval(() => this.poll(), syncOptions.pollMs);
    this.timer.unref?.();
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const hubs = new WeakMap<Db, ChangeHub>();

export function hubFor(db: Db): ChangeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = new ChangeHub(db);
    hubs.set(db, hub);
  }
  return hub;
}
