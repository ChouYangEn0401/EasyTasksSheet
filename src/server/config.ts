import { existsSync } from 'node:fs';
import { z } from 'zod';

// 載入專案根目錄的 .env（若存在）。已存在的環境變數不會被覆寫。
if (existsSync('.env')) process.loadEnvFile('.env');

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optionalStr = z.string().optional();

/** 全部環境變數；說明與預設值見 .env.example */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  WEB_PORT: z.coerce.number().int().default(5173),
  APP_ORIGIN: optionalStr,
  DATABASE_PATH: z.string().default('data/app.db'),
  STATIC_DIR: z.string().default('dist/web'),
  TZ: z.string().default('Asia/Taipei'),

  SESSION_MAX_HOURS: z.coerce.number().positive().default(9),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(60),
  COOKIE_SECURE: bool.optional(),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  LOGIN_MAX_FAILS_PER_USER: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  LOGIN_MAX_FAILS_PER_IP: z.coerce.number().int().positive().default(20),
  ADMIN_USERNAME: optionalStr,
  ADMIN_PASSWORD: optionalStr,

  CHANGES_RETENTION_DAYS: z.coerce.number().positive().default(30),

  GITHUB_TOKEN: optionalStr,
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  ISSUE_CACHE_MINUTES: z.coerce.number().positive().default(5),
  WORKTREE_STALE_DAYS: z.coerce.number().positive().default(7),
  WORKTREE_REPORT_TOKEN: optionalStr,
  GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof envSchema> & { isProduction: boolean; cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // 空字串視同未設定（.env.example 直接複製時許多值為空）
  const parsed = envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const isProduction = parsed.NODE_ENV === 'production';
  return { ...parsed, isProduction, cookieSecure: parsed.COOKIE_SECURE ?? isProduction };
}

export const config = loadConfig();
