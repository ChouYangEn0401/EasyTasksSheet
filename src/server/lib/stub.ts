import { Hono } from 'hono';
import type { AppEnv } from './context.ts';
import { notImplemented } from './errors.ts';

/** 尚未實作的 feature router：任何路徑都回 501（而非 404） */
export function stubRouter(feature: string): Hono<AppEnv> {
  return new Hono<AppEnv>().all('*', () => {
    throw notImplemented(`${feature} 尚未實作`);
  });
}
