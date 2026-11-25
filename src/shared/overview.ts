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
     * 本週完成：category = done 且 completed_at（轉為 done 的時刻）落在本週
     * （Asia/Taipei 週一 00:00 起）；不含已刪除任務。完成後再編輯其他欄位不影響。
     */
    doneThisWeek: z.number(),
    /** 目前無任務的成員數 */
    idleMembers: z.number(),
    activeMembers: z.number(),
  }),
  /**
   * 只含啟用中的成員；已排序：
   * 無任務者在前（待辦數少 → 多），其後進行中者（逾期多 → 少），同條件依使用者 id。
   * 同條件成員的名稱定序（zh-Hant）由前端 sortOverviewMembers 處理。
   */
  members: z.array(memberSummary),
  unassigned: z.object({
    openCount: z.number(),
    remainingHours: z.number(),
    unestimatedCount: z.number(),
  }),
});
export type OverviewResponse = z.infer<typeof overviewResponse>;

/* ── GET /api/overview/activity?weeks=3：近三週大家大概做了多少事（gantt-overview.md §B5） ── */

/** 一週的件數（全隊合計與個人共用） */
export const activityWeekStats = z.object({
  /** completed_at 落在該週、目前仍為完成的任務數（歸給目前的負責人） */
  completed: z.number(),
  /** 該週新增或更新過的不同任務數（依 changes 表，歸給動手的人；可能包含已完成的任務） */
  touched: z.number(),
  /** completed ∪ touched 的不同任務數（迷你直條高度依據） */
  involved: z.number(),
  /** 完成任務中有填預估工時者的合計 */
  completedHours: z.number(),
  /** 完成任務中有填預估工時的件數；0 = 不顯示工時 */
  hoursKnown: z.number(),
});
export type ActivityWeekStats = z.infer<typeof activityWeekStats>;

export const activityItem = z.object({
  id: z.number().int(),
  title: z.string(),
  statusId: z.number().int(),
  estimateHours: z.number().nullable(),
  completed: z.boolean(),
  touched: z.boolean(),
  /** 完成時刻（完成者）或該週最後一次處理的時刻（Unix ms） */
  at: z.number().int(),
});
export type ActivityItem = z.infer<typeof activityItem>;

export const memberActivityWeek = activityWeekStats.extend({
  /** 完成在前、時間新 → 舊；最多 20 筆 */
  items: z.array(activityItem),
  itemsTotal: z.number(),
});
export type MemberActivityWeek = z.infer<typeof memberActivityWeek>;

export const activityResponse = z.object({
  /** 由舊到新（前週、上週、本週）；current = 進行中的本週 */
  weeks: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      current: z.boolean(),
      /** 週起點早於 changes 保留界線（預設 30 天），「處理」件數可能不完整 */
      touchedPartial: z.boolean(),
    }),
  ),
  teamWeeks: z.array(activityWeekStats),
  /** 只含啟用中的成員，依使用者 id */
  members: z.array(z.object({ userId: z.number().int(), weeks: z.array(memberActivityWeek) })),
});
export type ActivityResponse = z.infer<typeof activityResponse>;
