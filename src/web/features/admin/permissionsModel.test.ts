import { describe, expect, it } from 'vitest';
import type { PermissionCapability, PermissionMatrix } from '../../../shared/permissions.ts';
import {
  cellValue,
  changeSummary,
  groupCapabilities,
  hasOverrides,
  isCustomized,
  pendingChanges,
  toggleCell,
} from './permissionsModel.ts';

const cap = (
  key: string,
  label: string,
  min: 'user' | 'manager' | 'root',
  over = {},
): PermissionCapability => {
  const d = { root: true, manager: min !== 'root', user: min === 'user' };
  return {
    key,
    label,
    description: '',
    group: key.split('.')[0]!,
    protected: min === 'root',
    defaults: d,
    effective: { ...d },
    overridden: { manager: false, user: false },
    ...over,
  };
};

const matrix = (): PermissionMatrix => ({
  roles: [
    { role: 'root', label: '超級管理員', configurable: false },
    { role: 'manager', label: '管理者', configurable: true },
    { role: 'user', label: '成員', configurable: true },
  ],
  groups: [
    { key: 'tasks', label: '任務與專案' },
    { key: 'statuses', label: '狀態' },
    { key: 'empty', label: '空' },
    { key: 'data', label: '資料' },
  ],
  capabilities: [
    cap('tasks.edit', '編輯任務', 'user'),
    cap('statuses.manage', '管理狀態', 'manager'),
    cap('data.backup_db', '完整備份下載', 'root'),
  ],
  lastUpdated: null,
});

describe('permissionsModel', () => {
  it('切換、還原同值時移除變更；摘要依角色（成員在前）', () => {
    const m = matrix();
    const [tasks, statuses] = m.capabilities;
    let d = toggleCell({}, statuses!, 'user', true);
    d = toggleCell(d, tasks!, 'user', false);
    d = toggleCell(d, statuses!, 'manager', false);
    expect(cellValue(d, statuses!, 'user')).toBe(true);
    const changes = pendingChanges(m, d);
    expect(changes).toEqual([
      { role: 'manager', capability: 'statuses.manage', allowed: false },
      { role: 'user', capability: 'tasks.edit', allowed: false },
      { role: 'user', capability: 'statuses.manage', allowed: true },
    ]);
    expect(changeSummary(m, changes)).toBe('成員：－編輯任務、＋管理狀態；管理者：－管理狀態');
    d = toggleCell(d, statuses!, 'manager', true);
    expect(pendingChanges(m, d)).toHaveLength(2);
  });

  it('受保護項目不列入變更', () => {
    const m = matrix();
    expect(pendingChanges(m, { 'user:data.backup_db': true })).toEqual([]);
  });

  it('已自訂、有覆寫、分組', () => {
    const m = matrix();
    const statuses = m.capabilities[1]!;
    expect(isCustomized({}, statuses)).toBe(false);
    expect(isCustomized({ 'user:statuses.manage': true }, statuses)).toBe(true);
    expect(hasOverrides(m)).toBe(false);
    m.capabilities[1] = { ...statuses, overridden: { manager: false, user: true } };
    expect(hasOverrides(m)).toBe(true);
    expect(groupCapabilities(m).map((g) => g.key)).toEqual(['tasks', 'statuses', 'data']);
  });
});
