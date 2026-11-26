
export const FEEDBACK_KINDS = ['problem', 'feedback'];

export const FEEDBACK_STATUSES = ['open', 'scheduled', 'resolved'];

export const FEEDBACK_KIND_LABELS = { problem: '問題', feedback: '回饋' };
export const FEEDBACK_STATUS_LABELS = {
  open: '未排程',
  scheduled: '已排程',
  resolved: '已解決',
};

/** 由「是否已解決」與排程日推導狀態 */
export function deriveFeedbackStatus(resolved, scheduledDate) {
  if (resolved) return 'resolved';
  return scheduledDate ? 'scheduled' : 'open';
}
