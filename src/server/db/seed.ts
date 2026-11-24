import { count } from 'drizzle-orm';
import type { Db } from './client.ts';
import { projects, statuses } from './schema.ts';

export const DEFAULT_STATUSES = [
  { name: '待辦', color: '#94a3b8', category: 'todo', sortOrder: 1 },
  { name: '進行中', color: '#3b82f6', category: 'doing', sortOrder: 2 },
  { name: '審查中', color: '#f59e0b', category: 'doing', sortOrder: 3 },
  { name: '完成', color: '#22c55e', category: 'done', sortOrder: 4 },
] as const;

export const DEFAULT_PROJECT = { name: '預設專案', color: '#4f6bed', sortOrder: 1 };

/** 寫入預設資料；只在資料表為空時寫入，可重複執行 */
export function runSeed(db: Db): void {
  db.transaction((tx) => {
    if (tx.select({ n: count() }).from(statuses).get()!.n === 0) {
      tx.insert(statuses)
        .values([...DEFAULT_STATUSES])
        .run();
    }
    if (tx.select({ n: count() }).from(projects).get()!.n === 0) {
      tx.insert(projects).values(DEFAULT_PROJECT).run();
    }
  });
}
