import { max } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../db/client.ts';

/** 新項目排在最後：目前最大 sort_order + 1 */
export function nextSortOrder(db: DbOrTx, table: SQLiteTable, column: SQLiteColumn): number {
  const row = db
    .select({ m: max(column) })
    .from(table)
    .get();
  return Number(row?.m ?? 0) + 1;
}
