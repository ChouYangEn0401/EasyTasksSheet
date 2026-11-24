// 骨架：由 feat/feedback-calendar 實作。
import { z } from 'zod';
import { dateString, timestamps } from './common.ts';

export const FEEDBACK_KINDS = ['problem', 'feedback'] as const;
export const feedbackKind = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKind>;

export const FEEDBACK_STATUSES = ['open', 'scheduled', 'resolved'] as const;
export const feedbackStatus = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatus>;

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
