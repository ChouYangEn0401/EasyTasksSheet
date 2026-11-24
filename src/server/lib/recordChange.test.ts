import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../../tests/helpers/db.ts';
import { changes } from '../db/schema.ts';
import { pruneChanges, recordChange } from './recordChange.ts';

describe('recordChange', () => {
  it('寫入遞增的變更流水', () => {
    const db = createTestDb();
    const a = recordChange(db, { entityType: 'task', entityId: 1, action: 'create', actorId: null });
    const b = recordChange(db, { entityType: 'task', entityId: 1, action: 'update', actorId: null });
    expect(b).toBeGreaterThan(a);
    const rows = db.select().from(changes).all();
    expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
  });

  it('可在 transaction 內使用，rollback 時一併撤銷', () => {
    const db = createTestDb();
    expect(() =>
      db.transaction((tx) => {
        recordChange(tx, { entityType: 'project', entityId: 1, action: 'update', actorId: null });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.select().from(changes).all()).toHaveLength(0);
  });

  it('pruneChanges 刪除過期流水', () => {
    const db = createTestDb();
    db.insert(changes)
      .values([
        { entityType: 'task', entityId: 1, action: 'create', createdAt: 1000 },
        { entityType: 'task', entityId: 2, action: 'create', createdAt: 5000 },
      ])
      .run();
    expect(pruneChanges(db, 2000)).toBe(1);
    expect(
      db
        .select()
        .from(changes)
        .all()
        .map((r) => r.entityId),
    ).toEqual([2]);
  });
});
