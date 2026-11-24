import type { Db } from '../db/client.ts';
import type { sessions, users } from '../db/schema.ts';
import type { AuthSettings } from './settings.ts';

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/** 每個 Hono context 上的依賴 */
export type AppVariables = {
  db: Db;
  /** 可注入的時鐘（測試用假時鐘） */
  now: () => number;
  settings: AuthSettings;
  /** 由 session middleware 設定；公開路由（health、login、logout）上不存在 */
  user: UserRow;
  session: SessionRow;
};

export type AppEnv = { Variables: AppVariables };
