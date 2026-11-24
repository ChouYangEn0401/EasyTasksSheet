import type { Db } from '../db/client.ts';

/** 掛在 Hono context 上的依賴；core/auth-data 會再加入登入者資訊 */
export type AppVariables = {
  db: Db;
  /** 可注入的時鐘（測試用假時鐘） */
  now: () => number;
};

export type AppEnv = { Variables: AppVariables };
