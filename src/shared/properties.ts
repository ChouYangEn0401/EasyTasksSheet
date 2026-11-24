import { z } from 'zod';
import { timestamps } from './common.ts';
import { tagColor } from './projects.ts';

export const PROPERTY_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'person',
] as const;
export const propertyType = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof propertyType>;

export const selectOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(100),
  color: tagColor.optional(),
});
export type SelectOption = z.infer<typeof selectOption>;

export const propertyDef = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  type: propertyType,
  options: z.array(selectOption),
  sortOrder: z.number(),
  ...timestamps,
});
export type PropertyDef = z.infer<typeof propertyDef>;

export const propertyCreateInput = z.object({
  projectId: z.number().int().nullable().optional(),
  name: z.string().trim().min(1).max(100),
  type: propertyType,
  options: z.array(selectOption).optional(),
});
export type PropertyCreateInput = z.infer<typeof propertyCreateInput>;

export const propertyUpdateInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  options: z.array(selectOption).optional(),
  sortOrder: z.number().optional(),
});
export type PropertyUpdateInput = z.infer<typeof propertyUpdateInput>;

/**
 * tasks.custom 格式：{ "<property_id>": value }。
 * 寫入時依 property 型別驗證：text=string、number=number、select=選項 id、multi_select=選項 id 陣列、
 * date=YYYY-MM-DD、checkbox=boolean、url=URL 字串、person=使用者 id。
 * PATCH 時與既有值逐鍵合併，值為 null 代表清除該欄。
 */
export const customValues = z.record(z.string(), z.unknown());
export type CustomValues = z.infer<typeof customValues>;
