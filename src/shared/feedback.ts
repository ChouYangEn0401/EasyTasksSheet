import { z } from 'zod';
import { dateString, timestamps } from './common.ts';

export const FEEDBACK_KINDS = ['problem', 'feedback'] as const;
export const feedbackKind = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKind>;

export const FEEDBACK_STATUSES = ['open', 'scheduled', 'resolved'] as const;
export const feedbackStatus = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatus>;

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { problem: '問題', feedback: '回饋' };
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: '未排程',
  scheduled: '已排程',
  resolved: '已解決',
};

export const feedbackItem = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  kind: feedbackKind,
  title: z.string(),
  body: z.string(),
  status: feedbackStatus,
  scheduledDate: dateString.nullable(),
  reporterId: z.number().int().nullable(),
  assigneeId: z.number().int().nullable(),
  updatedBy: z.number().int().nullable(),
  ...timestamps,
});
export type FeedbackItem = z.infer<typeof feedbackItem>;

/** 合法的日曆日期（YYYY-MM-DD 且確實存在，例如排除 2026-02-30） */
export const calendarDate = dateString.refine((s) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}, '日期不存在');

/** 建立：只需 kind + title；reporter 由後端帶入目前使用者 */
export const feedbackCreateInput = z.object({
  kind: feedbackKind,
  title: z.string().trim().min(1, '請輸入標題').max(500),
  body: z.string().max(20_000).optional(),
  projectId: z.number().int().nullable().optional(),
  assigneeId: z.number().int().nullable().optional(),
  scheduledDate: calendarDate.nullable().optional(),
});
export type FeedbackCreateInput = z.infer<typeof feedbackCreateInput>;

/**
 * PATCH 只送改動欄位。status 不可直接寫入，改由後端推導：
 * - resolved=true → 已解決（保留排程日）
 * - resolved=false（重新開啟）或未解決時 → 依 scheduledDate 有無為 已排程 / 未排程
 */
export const feedbackUpdateInput = feedbackCreateInput.partial().extend({ resolved: z.boolean().optional() });
export type FeedbackUpdateInput = z.infer<typeof feedbackUpdateInput>;

/** 由「是否已解決」與排程日推導狀態 */
export function deriveFeedbackStatus(resolved: boolean, scheduledDate: string | null): FeedbackStatus {
  if (resolved) return 'resolved';
  return scheduledDate ? 'scheduled' : 'open';
}

function enumList<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)));
}

/** GET /api/feedback 的篩選：kind、status 皆為逗號分隔多值；from / to 限制排程日區間（含） */
export const feedbackListQuery = z.object({
  kind: enumList(FEEDBACK_KINDS).optional(),
  status: enumList(FEEDBACK_STATUSES).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});
export type FeedbackListQuery = z.infer<typeof feedbackListQuery>;
