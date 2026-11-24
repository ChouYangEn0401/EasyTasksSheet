// 骨架：由 feat/gantt-overview 實作。
import { z } from 'zod';

export const memberSummary = z.object({
  userId: z.number().int(),
  displayName: z.string(),
  doingTaskIds: z.array(z.number().int()),
  openEstimateHours: z.number(),
  counts: z.object({ todo: z.number(), doing: z.number(), done: z.number() }),
  overdue: z.number(),
});
export type MemberSummary = z.infer<typeof memberSummary>;

export const overviewResponse = z.object({
  members: z.array(memberSummary),
  statusCounts: z.array(z.object({ statusId: z.number().int(), count: z.number() })),
  doneThisWeek: z.number(),
});
export type OverviewResponse = z.infer<typeof overviewResponse>;
