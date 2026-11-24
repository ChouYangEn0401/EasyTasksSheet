import type { StatusCategory } from '../../../shared/projects.ts';
import type { MemberSummary, OverviewDoingTask, OverviewResponse } from '../../../shared/overview.ts';

/*
 * 總覽彙總（純函式，方便以固定資料測試）。
 * 定義（docs/design/gantt-overview.md §B4）：
 * - 目前無任務：category doing 的任務數為 0
 * - 逾期：到期日早於今天且 category ≠ done
 * - 未完成預估：category ≠ done 的 estimate_hours 合計
 * - 本週完成（近似）：category done 且 updated_at 落在本週（週一 00:00 至下週一 00:00，以 tz 計）
 */

export type OverviewStatus = {
  id: number;
  name: string;
  color: string;
  category: StatusCategory;
  sortOrder: number;
};
export type OverviewUser = { id: number; username: string; displayName: string; isActive: boolean };
export type OverviewTask = {
  id: number;
  title: string;
  statusId: number;
  assigneeId: number | null;
  dueDate: string | null;
  estimateHours: number | null;
  updatedAt: number;
  updatedBy: number | null;
};

const DAY_MS = 86_400_000;

/** 某時區下的日期字串 YYYY-MM-DD */
export function dateInZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** 該時區在某時刻相對 UTC 的位移（ms） */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const utcDay = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 10);

/** 本週（週一至週日）範圍與起訖時刻 */
export function weekOf(now: number, timeZone: string) {
  const today = dateInZone(now, timeZone);
  const todayUtc = utcDay(today);
  const dow = (new Date(todayUtc).getUTCDay() + 6) % 7; // 週一 = 0
  const startUtc = todayUtc - dow * DAY_MS;
  const endUtc = startUtc + 6 * DAY_MS;
  // 該時區當地 00:00 對應的時刻
  const localMidnight = (utcMs: number) => utcMs - zoneOffset(utcMs, timeZone);
  return {
    today,
    start: toDate(startUtc),
    end: toDate(endUtc),
    startMs: localMidnight(startUtc),
    endMs: localMidnight(startUtc + 7 * DAY_MS),
  };
}

const byName = (a: { user: { displayName: string } }, b: { user: { displayName: string } }) =>
  a.user.displayName.localeCompare(b.user.displayName, 'zh-Hant');

/** 成員排序：無任務在前（待辦少 → 多，再依名稱）；進行中（逾期多 → 少，再依名稱） */
export function sortMembers<T extends Pick<MemberSummary, 'idle' | 'counts' | 'overdue' | 'user'>>(
  list: T[],
): T[] {
  return [...list].sort((a, b) => {
    if (a.idle !== b.idle) return a.idle ? -1 : 1;
    if (a.idle) return a.counts.todo - b.counts.todo || byName(a, b);
    return b.overdue - a.overdue || byName(a, b);
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeOverview(input: {
  statuses: OverviewStatus[];
  users: OverviewUser[];
  tasks: OverviewTask[];
  now: number;
  timeZone: string;
}): OverviewResponse {
  const { statuses, users, tasks, now, timeZone } = input;
  const week = weekOf(now, timeZone);
  const { today } = week;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const categoryOf = (t: OverviewTask): StatusCategory => statusById.get(t.statusId)?.category ?? 'todo';
  const isOverdue = (t: OverviewTask) => !!t.dueDate && t.dueDate < today && categoryOf(t) !== 'done';

  const statusCount = new Map<number, number>();
  let overdue = 0;
  let doneThisWeek = 0;
  for (const t of tasks) {
    statusCount.set(t.statusId, (statusCount.get(t.statusId) ?? 0) + 1);
    if (isOverdue(t)) overdue += 1;
    if (categoryOf(t) === 'done' && t.updatedAt >= week.startMs && t.updatedAt < week.endMs)
      doneThisWeek += 1;
  }

  const byAssignee = new Map<number | null, OverviewTask[]>();
  for (const t of tasks) {
    const list = byAssignee.get(t.assigneeId) ?? [];
    list.push(t);
    byAssignee.set(t.assigneeId, list);
  }

  const summarize = (list: OverviewTask[]) => {
    const counts = { todo: 0, doing: 0, done: 0 };
    let remainingHours = 0;
    let unestimatedCount = 0;
    let memberOverdue = 0;
    let lastUpdatedAt: number | null = null;
    const doing: OverviewDoingTask[] = [];
    for (const t of list) {
      const cat = categoryOf(t);
      counts[cat] += 1;
      if (cat !== 'done') {
        if (t.estimateHours == null) unestimatedCount += 1;
        else remainingHours += t.estimateHours;
      }
      if (isOverdue(t)) memberOverdue += 1;
      if (lastUpdatedAt == null || t.updatedAt > lastUpdatedAt) lastUpdatedAt = t.updatedAt;
      if (cat === 'doing') {
        doing.push({
          id: t.id,
          title: t.title,
          statusId: t.statusId,
          dueDate: t.dueDate,
          updatedAt: t.updatedAt,
          updatedBy: t.updatedBy,
        });
      }
    }
    doing.sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt || a.id - b.id;
    });
    return {
      counts,
      remainingHours: round2(remainingHours),
      unestimatedCount,
      overdue: memberOverdue,
      lastUpdatedAt,
      doing,
    };
  };

  const members: MemberSummary[] = users
    .filter((u) => u.isActive)
    .map((u) => {
      const s = summarize(byAssignee.get(u.id) ?? []);
      return {
        user: { id: u.id, username: u.username, displayName: u.displayName },
        ...s,
        idle: s.counts.doing === 0,
      };
    });

  const un = summarize(byAssignee.get(null) ?? []);
  const sorted = sortMembers(members);

  return {
    today,
    weekRange: { start: week.start, end: week.end },
    totals: {
      byStatus: [...statuses]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((s) => ({
          statusId: s.id,
          name: s.name,
          category: s.category,
          color: s.color,
          count: statusCount.get(s.id) ?? 0,
        })),
      overdue,
      doneThisWeek,
      idleMembers: sorted.filter((m) => m.idle).length,
      activeMembers: sorted.length,
    },
    members: sorted,
    unassigned: {
      openCount: un.counts.todo + un.counts.doing,
      remainingHours: un.remainingHours,
      unestimatedCount: un.unestimatedCount,
    },
  };
}
