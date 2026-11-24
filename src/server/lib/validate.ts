import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from './errors.ts';

/** 讀取並以 Zod 驗證 JSON body；驗證失敗丟 ZodError（由統一錯誤處理轉為 400） */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('請求內容須為 JSON');
  }
  return schema.parse(body);
}

/** 以 Zod 驗證 query string */
export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  return schema.parse(c.req.query());
}
