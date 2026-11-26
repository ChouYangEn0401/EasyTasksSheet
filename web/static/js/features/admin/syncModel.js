import { formatValue } from './dataModel.js';

export const RESOLUTION_TEXT = {
  keep_local: '保留中央',
  use_incoming: '採用上傳',
  merged: '逐欄位合併',
};

/** 本機執行的上傳命令（金鑰只在建立 / 重新產生時顯示一次） */
export function pushCommand(origin, token) {
  return `python -m server.cli sync-push --server ${origin} --token ${token}`;
}

/** 「差 N 分鐘」 */
export function diffText(minutes) {
  if (minutes < 1) return '差不到 1 分鐘';
  return `差 ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分鐘`;
}

/** 最後一次同步摘要的一行文字 */
export function summaryText(t) {
  if (!t) return '尚未同步';
  const parts = [
    `新增 ${t.created}`,
    `更新 ${t.updated}`,
    `相同 ${t.unchanged}`,
    t.conflict ? `衝突 ${t.conflict}` : '',
    t.skipped + t.older ? `略過 ${t.skipped + t.older}` : '',
  ].filter(Boolean);
  return parts.join('、');
}

/** 欄位值的顯示文字：有可讀文字（專案名稱、成員名稱…）時優先 */
export function fieldText(value, display) {
  return formatValue(display ?? value);
}

/** 依逐欄位選擇組出送出的 body：全選同一邊時改用 keep_local / use_incoming */
export function buildResolveInput(fields, choices) {
  const picks = fields.map((f) => choices[f.name] ?? 'local');
  if (picks.every((p) => p === 'local')) return { resolution: 'keep_local' };
  if (picks.every((p) => p === 'incoming')) return { resolution: 'use_incoming' };
  return {
    resolution: 'merged',
    choices: Object.fromEntries(fields.map((f, i) => [f.name, picks[i]])),
  };
}

export function allChoices(fields, side) {
  return Object.fromEntries(fields.map((f) => [f.name, side]));
}
