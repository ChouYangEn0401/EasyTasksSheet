import type { Config } from '../config.ts';

/** 認證相關設定（毫秒為單位）；由 Config 轉換，測試可直接覆寫 */
export type AuthSettings = {
  sessionMaxMs: number;
  idleTimeoutMs: number;
  cookieSecure: boolean;
  /** 允許的 Origin；未設定時以請求 Host 判斷同源 */
  appOrigin?: string;
  loginWindowMs: number;
  loginMaxFailsPerUser: number;
  loginLockMs: number;
  loginMaxFailsPerIp: number;
};

const MINUTE = 60_000;

export function authSettingsFrom(config: Config): AuthSettings {
  return {
    sessionMaxMs: config.SESSION_MAX_HOURS * 60 * MINUTE,
    idleTimeoutMs: config.SESSION_IDLE_MINUTES * MINUTE,
    cookieSecure: config.cookieSecure,
    appOrigin: config.APP_ORIGIN,
    loginWindowMs: config.LOGIN_WINDOW_MINUTES * MINUTE,
    loginMaxFailsPerUser: config.LOGIN_MAX_FAILS_PER_USER,
    loginLockMs: config.LOGIN_LOCK_MINUTES * MINUTE,
    loginMaxFailsPerIp: config.LOGIN_MAX_FAILS_PER_IP,
  };
}
