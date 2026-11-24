import type { IdleSnapshot } from './idle.ts';

/** 閒置登出前多久提醒 */
export const IDLE_WARNING_MS = 5 * 60_000;
/** 9 小時絕對到期前多久警示 */
export const ABSOLUTE_WARNING_MS = 5 * 60_000;

export type IdleWarningState = {
  /** 顯示閒置提醒 Dialog */
  idle: boolean;
  /** 顯示絕對到期 toast（與閒置提醒同時成立時只顯示這一則） */
  absolute: boolean;
  /** 距離自動登出的毫秒數（取兩者較早者） */
  remainingMs: number;
};

/** 依閒置狀態與現在時間決定要顯示哪個提醒（純函式） */
export function idleWarningState(s: IdleSnapshot, now: number): IdleWarningState {
  const none = { idle: false, absolute: false, remainingMs: Infinity };
  if (s.expired) return none;
  const idleLeft = s.idleDeadline != null ? s.idleDeadline - now : Infinity;
  const absLeft = s.absoluteDeadline != null ? s.absoluteDeadline - now : Infinity;
  const absolute = absLeft <= ABSOLUTE_WARNING_MS && absLeft > 0;
  // 絕對到期會先於閒置逾時發生時，延續也無用：只顯示絕對到期警示
  const idle = !absolute && idleLeft <= IDLE_WARNING_MS && idleLeft > 0;
  if (!idle && !absolute) return none;
  return { idle, absolute, remainingMs: Math.max(0, Math.min(idleLeft, absLeft)) };
}

/** 倒數顯示 m:ss */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
