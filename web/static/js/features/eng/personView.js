import { unregisteredReports } from './model.js';

/** 工作樹分頁的「檢視」：網址參數 ?user=<id|all>；沒有參數 = 我自己 */
export const VIEW_PARAM = 'user';
export const VIEW_ALL = 'all';

export function readPersonView(raw, meId) {
  if (raw == null || raw === '') return { kind: 'user', id: meId };
  if (raw === VIEW_ALL) return { kind: 'all' };
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { kind: 'user', id: Number(raw) };
  return { kind: 'invalid' };
}

/** 寫回網址：我自己 = 不帶參數；其餘保留其他參數 */
export function writePersonView(sp, value, meId) {
  const next = new URLSearchParams(sp);
  if (value === String(meId)) next.delete(VIEW_PARAM);
  else next.set(VIEW_PARAM, value);
  return next;
}

/** 一位成員在某台電腦上的紀錄；extras = 該電腦的「未登記回報 / 待確認」一併顯示在這裡 */

const collator = new Intl.Collator('zh-Hant');

/** 電腦上有沒有需要處理的回報提示（未登記、待確認） */
export const hasExtras = (g) => unregisteredReports(g).length > 0 || g.repos.some((r) => r.pending != null);

export const countRecords = (slices) => slices.reduce((n, s) => n + s.records.length, 0);

/**
 * 依成員 → 電腦兩層分組。
 * - 單一成員：只含該成員為負責人的紀錄，電腦層級保留原順序；未登記回報 / 待確認跟著有該成員紀錄的電腦。
 * - 全部成員：我自己在前，其餘依名稱（zh-Hant）；未指派放最後，並收納所有電腦的未登記回報 / 待確認。
 */
export function groupByOwner(machines, view, meId, nameOf) {
  const sliceFor = (ownerId, withExtras) => {
    const out = [];
    for (const g of machines) {
      const records = g.records.filter((r) => (r.ownerId ?? null) === ownerId);
      const extras = withExtras && hasExtras(g);
      if (records.length > 0 || (ownerId === null && extras)) out.push({ group: g, records, extras });
    }
    return out;
  };
  const bucket = (ownerId, slices) => ({
    key: ownerId == null ? 'none' : String(ownerId),
    ownerId,
    slices,
    count: countRecords(slices),
  });

  if (view.kind === 'user') return [bucket(view.id, sliceFor(view.id, true))];

  const ids = new Set();
  for (const g of machines) for (const r of g.records) if (r.ownerId != null) ids.add(r.ownerId);
  const ordered = [...ids].sort((a, b) => {
    if (a === meId) return -1;
    if (b === meId) return 1;
    return collator.compare(nameOf(a), nameOf(b)) || a - b;
  });
  const buckets = ordered.map((id) => bucket(id, sliceFor(id, false)));
  // 未登記回報 / 待確認屬於電腦、不屬於任何人，全部成員檢視時集中在「未指派」
  const unassigned = sliceFor(null, true);
  if (unassigned.length > 0) buckets.push(bucket(null, unassigned));
  return buckets;
}

/** 未指派負責人的紀錄筆數（含全站，用於「我自己」檢視頂部提示） */
export const unassignedCount = (machines) =>
  machines.reduce((n, g) => n + g.records.filter((r) => r.ownerId == null).length, 0);

/** 提示總數：未登記回報 + 待確認（我自己檢視看不到的電腦層級提示） */
export const extrasCount = (machines) =>
  machines.reduce(
    (n, g) => n + unregisteredReports(g).length + g.repos.filter((r) => r.pending != null).length,
    0,
  );

/** 各狀態件數（依第一次出現的順序），用於成員卡片的摘要 */
export function countByStatus(records) {
  const m = new Map();
  for (const r of records) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return [...m].map(([status, count]) => ({ status, count }));
}

/** 檢視範圍內的紀錄（回收區用）：全部成員不篩；單一成員 = 負責人為該成員 */
export function inView(records, view) {
  return view.kind === 'all' ? records : records.filter((r) => r.ownerId === view.id);
}
