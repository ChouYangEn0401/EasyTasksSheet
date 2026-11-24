import { eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { dateString } from '../../../shared/common.ts';
import type { CustomValues, PropertyType, SelectOption } from '../../../shared/properties.ts';
import type { DbOrTx } from '../../db/client.ts';
import { propertyDefs, users } from '../../db/schema.ts';
import { badRequest } from '../../lib/errors.ts';

function valueSchema(type: PropertyType, options: SelectOption[]): z.ZodType {
  const optionId = z.enum(options.map((o) => o.id) as [string, ...string[]]);
  switch (type) {
    case 'text':
      return z.string().max(10_000);
    case 'number':
      return z.number().finite();
    case 'select':
      return options.length ? optionId : z.never();
    case 'multi_select':
      return options.length
        ? z.array(optionId).refine((a) => new Set(a).size === a.length, '選項不可重複')
        : z.array(z.never());
    case 'date':
      return dateString;
    case 'checkbox':
      return z.boolean();
    case 'url':
      return z.url().max(2_000);
    case 'person':
      return z.number().int().positive();
  }
}

/**
 * 依 property_defs 的型別驗證自訂欄位值，並與既有值合併（null = 清除）。
 * 只接受全域或屬於該任務專案的 property；驗證失敗拋 ZodError（統一回 400）。
 */
export function mergeCustomValues(
  db: DbOrTx,
  projectId: number,
  current: CustomValues,
  patch: CustomValues,
): CustomValues {
  const keys = Object.keys(patch);
  if (keys.length === 0) return current;
  const defs = db
    .select()
    .from(propertyDefs)
    .where(or(isNull(propertyDefs.projectId), eq(propertyDefs.projectId, projectId)))
    .all();
  const byId = new Map(defs.map((d) => [String(d.id), d]));

  const shape: Record<string, z.ZodType> = {};
  for (const key of keys) {
    const def = byId.get(key);
    shape[key] = def ? valueSchema(def.type, def.options).nullable() : z.never({ error: '未知的自訂欄位' });
  }
  const parsed = z.strictObject(shape).parse(patch) as CustomValues;

  // person 型別需指向存在的使用者
  const personIds = keys
    .filter((k) => byId.get(k)?.type === 'person' && parsed[k] !== null)
    .map((k) => parsed[k] as number);
  if (personIds.length) {
    const found = db.select({ id: users.id }).from(users).where(inArray(users.id, personIds)).all();
    if (found.length !== new Set(personIds).size) throw badRequest('自訂欄位指定的成員不存在');
  }

  const next: CustomValues = { ...current };
  for (const key of keys) {
    if (parsed[key] === null) delete next[key];
    else next[key] = parsed[key];
  }
  return next;
}
