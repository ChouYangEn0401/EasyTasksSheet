// GET /api/overview 的回應契約（feat/gantt-overview）
import { z } from 'zod';
import { statusCategory } from './projects.ts';

/** 成員卡片上的「進行中」任務（category = doing，含審查中） */
export const overviewDoingTask = z.object({
  id: z.number().int(),
  title: z.string(),
  statusId: z.number().int(),
  dueDate: z.string().nullable(),
  updatedAt: z.number().int(),
  updatedBy: z.number().int().nullable(),
});
export type OverviewDoingTask = z.infer<typeof overviewDoingTask>;

export const statusCounts = z.object({ todo: z.number(), doing: z.number(), done: z.number() });
export type StatusCounts = z.infer<typeof statusCounts>;

export const memberSummary = z.object({
  user: z.object({ id: z.number().int(), username: z.string(), displayName: z.string() }),
  /** 進行中任務：依到期日（無到期日排後）、再依最近更新排序 */
  doing: z.array(overviewDoingTask),
  counts: statusCounts,
  /** 逾期 = 到期日早於今天且 category ≠ done */
  overdue: z.number(),
  /** 未完成（category ≠ done）任務的預估工時合計 */
  remainingHours: z.number(),
  /** 未完成且未填預估工時的任務數 */
  unestimatedCount: z.number(),
  /** 該成員任務中最新的 updated_at；沒有任務為 null */
  lastUpdatedAt: z.number().int().nullable(),
  /** 目前無任務 = 沒有 category doing 的任務 */
  idle: z.boolean(),
});
export type MemberSummary = z.infer<typeof memberSummary>;

export const statusTotal = z.object({
  statusId: z.number().int(),
  name: z.string(),
  category: statusCategory,
  color: z.string(),
  count: z.number(),
});
export type StatusTotal = z.infer<typeof statusTotal>;

export const overviewResponse = z.object({
  /** 計算基準日（Asia/Taipei，YYYY-MM-DD） */
  today: z.string(),
  /** 本週（週一至週日，含頭尾）YYYY-MM-DD */
  weekRange: z.object({ start: z.string(), end: z.string() }),
  totals: z.object({
    byStatus: z.array(statusTotal),
    overdue: z.number(),
    /**
     * 本週完成（近似值）：category = done 且 updated_at 落在本週。
     * schema 無完成時間欄位，完成後再被編輯也會計入當週。
     */
    doneThisWeek: z.number(),
    /** 目前無任務的成員數 */
    idleMembers: z.number(),
    activeMembers: z.number(),
  }),
  /**
   * 只含啟用中的成員；已排序：
   * 無任務者在前（待辦數少 → 多，再依名稱），其後進行中者（逾期多 → 少，再依名稱）
   */
  members: z.array(memberSummary),
  unassigned: z.object({
    openCount: z.number(),
    remainingHours: z.number(),
    unestimatedCount: z.number(),
  }),
});
export type OverviewResponse = z.infer<typeof overviewResponse>;
