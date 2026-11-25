import { TAG_COLORS, type Status, type StatusCategory, type TagColor } from '../../../shared/projects.ts';

/** 狀態類別的中文名稱與用途說明（管理狀態對話框） */
export const CATEGORY_LABELS: Record<StatusCategory, string> = {
  todo: '待處理',
  doing: '進行中',
  done: '已完成',
};
export const CATEGORY_HINT = '類別決定統計與看板歸類';

/** 把第 from 項移到第 to 項的位置（回傳新陣列；越界時原樣回傳） */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** 依新的順序重編 sortOrder（1..n），只回傳與目前值不同者（減少 PATCH） */
export function sortOrderChanges(
  ordered: readonly Pick<Status, 'id' | 'sortOrder'>[],
): { id: number; sortOrder: number }[] {
  return ordered.flatMap((s, i) => (s.sortOrder === i + 1 ? [] : [{ id: s.id, sortOrder: i + 1 }]));
}

/** 新增時預設挑一個尚未被使用的顏色（用完則輪替） */
export function nextFreeColor(used: readonly string[]): TagColor {
  const free = TAG_COLORS.filter((c) => !used.includes(c));
  return free[0] ?? TAG_COLORS[used.length % TAG_COLORS.length]!;
}

/** 刪除狀態時可改移任務的目標（排除自己） */
export function migrationTargets<T extends { id: number }>(statuses: readonly T[], id: number): T[] {
  return statuses.filter((s) => s.id !== id);
}

/** 預設的改移目標：優先同類別，其次第一個其他狀態 */
export function defaultMigrationTarget(
  statuses: readonly Pick<Status, 'id' | 'category'>[],
  removing: Pick<Status, 'id' | 'category'>,
): number | null {
  const others = migrationTargets(statuses, removing.id);
  return (others.find((s) => s.category === removing.category) ?? others[0])?.id ?? null;
}
