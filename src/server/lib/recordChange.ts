import { lt } from 'drizzle-orm';
import type { ChangeAction, EntityType } from '../../shared/sync.ts';
import type { DbOrTx } from '../db/client.ts';
import { changes } from '../db/schema.ts';

export type ChangeInput = {
  entityType: EntityType;
  entityId: number;
  action: ChangeAction;
  actorId: number | null;
};

/** 寫入一筆變更流水；所有寫入 API 都必須呼叫（建議與寫入同一個 transaction）。回傳 change id */
export function recordChange(db: DbOrTx, input: ChangeInput): number {
  const row = db.insert(changes).values(input).returning({ id: changes.id }).get();
  return row.id;
}

/** 刪除早於 cutoff（unix ms）的變更流水，回傳刪除筆數 */
export function pruneChanges(db: DbOrTx, cutoff: number): number {
  return db.delete(changes).where(lt(changes.createdAt, cutoff)).run().changes;
}
