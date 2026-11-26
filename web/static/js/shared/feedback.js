
export const FEEDBACK_KINDS = ['problem', 'feedback'];

export const FEEDBACK_STATUSES = ['open', 'scheduled', 'resolved'];

export const FEEDBACK_KIND_LABELS = { problem: '問題', feedback: '回饋' };
export const FEEDBACK_STATUS_LABELS = {
  open: '未排程',
  scheduled: '已排程',
  resolved: '已解決',
};

/** 合法的日曆日期（YYYY-MM-DD 且確實存在，例如排除 2026-02-30） */
export const calendarDate = dateString.refine((s) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}, '日期不存在');

/** 由「是否已解決」與排程日推導狀態 */
export function deriveFeedbackStatus(resolved, scheduledDate) {
  if (resolved) return 'resolved';
  return scheduledDate ? 'scheduled' : 'open';
}
