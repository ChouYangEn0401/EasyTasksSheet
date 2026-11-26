

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

export const TASK_PRIORITY_LABELS = {
  none: '無',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '緊急',
};

/** PATCH 只送改動的欄位（欄位層級後寫入者勝） */
export const taskUpdateInput = taskCreateInput.partial();
