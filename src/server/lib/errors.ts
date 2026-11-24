import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiError, ErrorCode } from '../../shared/common.ts';

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = '請求格式錯誤', details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '請先登入') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = '沒有權限') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = '找不到資源') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message = '資料衝突') => new HttpError(409, 'CONFLICT', message);
export const tooManyRequests = (message = '嘗試次數過多，請稍後再試') =>
  new HttpError(429, 'TOO_MANY_REQUESTS', message);
export const notImplemented = (message = '尚未實作') => new HttpError(501, 'NOT_IMPLEMENTED', message);

export function errorBody(code: ErrorCode, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

const HTTP_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'TOO_MANY_REQUESTS',
  501: 'NOT_IMPLEMENTED',
};

/** 統一錯誤處理：一律回 { error: { code, message } } */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof ZodError) {
    return c.json(errorBody('VALIDATION_ERROR', '資料驗證失敗', err.issues), 400);
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    return c.json(errorBody(HTTP_CODES[status] ?? 'BAD_REQUEST', err.message || '請求錯誤'), status);
  }
  console.error(err);
  return c.json(errorBody('INTERNAL_ERROR', '伺服器發生錯誤'), 500);
}
