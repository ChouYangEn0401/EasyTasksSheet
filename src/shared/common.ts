import { z } from 'zod';

/** 統一錯誤回應格式：{ error: { code, message } } */
export type ApiError = { error: { code: string; message: string; details?: unknown } };

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'TOO_MANY_REQUESTS',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 純日期欄位：YYYY-MM-DD（避免時區位移） */
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD');

export const idParam = z.coerce.number().int().positive();

/** 共通時間戳欄位（unix ms） */
export const timestamps = {
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
};

export const healthResponse = z.object({ ok: z.literal(true), time: z.number() });
export type HealthResponse = z.infer<typeof healthResponse>;
