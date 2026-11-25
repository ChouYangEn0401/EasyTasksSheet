import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/tasks.ts';
import { ApiError } from './api.ts';
import { errorToastInput } from './errorToast.ts';
import { createIdleTracker } from './idle.ts';
import { formatCountdown, idleWarningState } from './idleWarning.ts';
import { parseCssTime } from './motion.ts';
import { diffTaskFields, formatActors, formatFieldList, noticeText } from './remoteNotice.ts';
import { keysForChanges } from './sync.ts';

const task = (extra: Partial<Task> = {}): Task => ({
  id: 1,
  projectId: 1,
  title: 'T',
  description: '',
  statusId: 1,
  assigneeId: null,
  priority: 'none',
  startDate: null,
  dueDate: null,
  estimateHours: null,
  progress: 0,
  sortOrder: 0,
  custom: {},
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('他人變更提示', () => {
  it('比對變動欄位（排序值不算；自訂欄位用名稱）', () => {
    const before = task({ custom: { '5': 'a' } });
    const after = task({ statusId: 2, dueDate: '2026-12-01', sortOrder: 9, custom: { '5': 'b' } });
    expect(diffTaskFields(before, after, [{ id: 5, name: '客戶' }])).toEqual([
      { key: 'status', label: '狀態' },
      { key: 'dueDate', label: '到期日' },
      { key: 'p5', label: '客戶' },
    ]);
    expect(diffTaskFields(before, task({ custom: { '5': 'a' }, sortOrder: 3 }))).toEqual([]);
  });

  it('欄位最多 3 個、多人寫「等 N 人」', () => {
    expect(formatFieldList(['狀態', '到期日'])).toBe('狀態、到期日');
    expect(formatFieldList(['a', 'b', 'c', 'd', 'e'])).toBe('a、b、c 等 2 項');
    expect(formatActors(['李大華'])).toBe('李大華');
    expect(formatActors(['李大華', '王小明', '李大華'])).toBe('李大華 等 2 人');
  });

  it('提示條文字；比對不出欄位時只說更新了此項目', () => {
    const nameOf = (id: number | null) => (id === 2 ? '李大華' : '其他成員');
    expect(
      noticeText(
        { actorIds: [2], fields: [{ key: 'status', label: '狀態' }], unknown: false, at: 0 },
        nameOf,
      ),
    ).toBe('李大華 剛更新了此任務 · 狀態');
    expect(noticeText({ actorIds: [2], fields: [], unknown: true, at: 0 }, nameOf)).toBe(
      '李大華 剛更新了此項目',
    );
  });
});

describe('寫入失敗 toast 文案', () => {
  const retry = async () => undefined;
  it('依錯誤類型', () => {
    expect(errorToastInput(new ApiError(0, 'NETWORK_ERROR', 'x'), retry)).toMatchObject({
      title: '連線中斷，變更未送出',
      description: '已還原為先前的內容。',
      action: { label: '重試' },
    });
    expect(errorToastInput(new ApiError(400, 'VALIDATION_ERROR', '標題過長'))).toMatchObject({
      title: '內容格式不正確',
      description: '標題過長',
    });
    expect(errorToastInput(new ApiError(403, 'FORBIDDEN', 'x'))?.title).toBe('沒有權限執行此操作');
    expect(errorToastInput(new ApiError(404, 'NOT_FOUND', 'x'))).toMatchObject({
      title: '此項目已被刪除',
      description: '清單已更新。',
    });
    expect(errorToastInput(new ApiError(500, 'INTERNAL_ERROR', 'x'), retry)).toMatchObject({
      title: '無法儲存變更',
      action: { label: '重試' },
    });
    expect(errorToastInput(new ApiError(401, 'UNAUTHORIZED', 'x'))).toBeNull();
  });
});

describe('閒置提醒', () => {
  const base = { idleDeadline: 60 * 60_000, absoluteDeadline: 9 * 3600_000, expired: false };
  it('剩 5 分鐘時顯示', () => {
    expect(idleWarningState(base, 54 * 60_000).idle).toBe(false);
    const s = idleWarningState(base, 55 * 60_000);
    expect(s).toMatchObject({ idle: true, absolute: false, remainingMs: 5 * 60_000 });
    expect(idleWarningState({ ...base, expired: true }, 59 * 60_000).idle).toBe(false);
  });
  it('9 小時絕對到期前 5 分鐘：只顯示絕對到期警示', () => {
    const s = idleWarningState({ ...base, idleDeadline: 9 * 3600_000 - 60_000 }, 9 * 3600_000 - 4 * 60_000);
    expect(s).toMatchObject({ idle: false, absolute: true });
  });
  it('倒數格式', () => {
    expect(formatCountdown(5 * 60_000)).toBe('5:00');
    expect(formatCountdown(299_001)).toBe('5:00');
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(-5)).toBe('0:00');
  });
  it('其他分頁的較晚期限會同步，不送 heartbeat', () => {
    let sent = 0;
    const tracker = createIdleTracker({
      now: () => 1000,
      sendHeartbeat: async () => {
        sent++;
        return { expiresAt: 0, lastActiveAt: 0, idleTimeoutMs: 0 };
      },
      onExpire: () => undefined,
    });
    tracker.applySession({ expiresAt: 10_000_000, lastActiveAt: 1000, idleTimeoutMs: 3_600_000 }, 1000);
    tracker.syncDeadline(5_000_000);
    expect(tracker.getSnapshot().idleDeadline).toBe(5_000_000);
    tracker.syncDeadline(10);
    expect(tracker.getSnapshot().idleDeadline).toBe(5_000_000);
    expect(sent).toBe(0);
  });
});

describe('同步：實體 → 查詢鍵', () => {
  const c = (entityType: Parameters<typeof keysForChanges>[0][0]['entityType'], entityId = 1) => ({
    id: 1,
    entityType,
    entityId,
    action: 'update' as const,
    actorId: 2,
    createdAt: 0,
  });
  it('任務變更會重抓任務、總覽與個人清單；去重', () => {
    const keys = keysForChanges([c('task'), c('task', 2)], 1);
    expect(keys).toEqual([['tasks'], ['overview'], ['personal'], ['audit']]);
  });
  it('稽核紀錄：任務 / 成員 / 權限等變更都重抓稽核查詢，個人清單不會', () => {
    for (const t of ['task', 'project', 'status', 'property', 'user', 'permission'] as const)
      expect(keysForChanges([c(t)], 1)).toContainEqual(['audit']);
    expect(keysForChanges([c('personal')], 1)).not.toContainEqual(['audit']);
  });
  it('修改到自己時一併重抓 me', () => {
    expect(keysForChanges([c('user', 7)], 7)).toContainEqual(['auth', 'me']);
    expect(keysForChanges([c('user', 8)], 7)).not.toContainEqual(['auth', 'me']);
  });
  it('問題回饋與工程追蹤', () => {
    expect(keysForChanges([c('feedback')], 1)).toEqual([['feedback'], ['overview']]);
    expect(keysForChanges([c('worktree_plan')], 1)).toEqual([['eng']]);
  });
});

describe('motion', () => {
  it('解析 CSS 時間', () => {
    expect(parseCssTime('200ms')).toBe(200);
    expect(parseCssTime(' .32s')).toBe(320);
    expect(parseCssTime('0ms')).toBe(0);
    expect(parseCssTime('')).toBeNull();
  });
});
