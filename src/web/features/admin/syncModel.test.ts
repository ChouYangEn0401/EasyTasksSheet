import { describe, expect, it } from 'vitest';
import type { SyncConflictField } from '../../../shared/syncPush.ts';
import { allChoices, buildResolveInput, diffText, fieldText, pushCommand, summaryText } from './syncModel.ts';

const field = (name: string): SyncConflictField => ({
  name,
  label: name,
  local: 'L',
  incoming: 'I',
  localDisplay: null,
  incomingDisplay: null,
});

describe('buildResolveInput', () => {
  const fields = [field('title'), field('description')];
  it('全部保留中央 / 全部採用上傳', () => {
    expect(buildResolveInput(fields, {})).toEqual({ resolution: 'keep_local' });
    expect(buildResolveInput(fields, allChoices(fields, 'local'))).toEqual({ resolution: 'keep_local' });
    expect(buildResolveInput(fields, allChoices(fields, 'incoming'))).toEqual({ resolution: 'use_incoming' });
  });
  it('逐欄位混合 → merged，未選的欄位視為保留中央', () => {
    expect(buildResolveInput(fields, { title: 'incoming' })).toEqual({
      resolution: 'merged',
      choices: { title: 'incoming', description: 'local' },
    });
  });
});

it('diffText', () => {
  expect(diffText(0.4)).toBe('差不到 1 分鐘');
  expect(diffText(3)).toBe('差 3 分鐘');
  expect(diffText(2.5)).toBe('差 2.5 分鐘');
});

it('summaryText', () => {
  expect(summaryText(null)).toBe('尚未同步');
  expect(summaryText({ created: 1, updated: 2, unchanged: 3, conflict: 0, skipped: 1, older: 1 })).toBe(
    '新增 1、更新 2、相同 3、略過 2',
  );
  expect(summaryText({ created: 0, updated: 0, unchanged: 0, conflict: 2, skipped: 0, older: 0 })).toBe(
    '新增 0、更新 0、相同 0、衝突 2',
  );
});

it('fieldText 與 pushCommand', () => {
  expect(fieldText('uid123', '預設專案')).toBe('預設專案');
  expect(fieldText(null, null)).toBe('（空）');
  expect(pushCommand('https://x.example', 'tss_abc')).toBe(
    'python -m server.cli sync-push --server https://x.example --token tss_abc',
  );
});
