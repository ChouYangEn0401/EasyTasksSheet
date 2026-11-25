import type { PasteItem } from '../../../shared/engManual.ts';

/** 電腦名稱沒填時的預設值（與伺服器一致） */
export const DEFAULT_PASTE_MACHINE = '我的電腦';

/** 預設勾選：未登記（新增 / 可能搬動）、非暫時性、非重複行。暫時性項目使用者可手動勾選 */
export function isDefaultPicked(i: PasteItem): boolean {
  return i.action !== 'existing' && !i.isTemp && !i.duplicate;
}

/** 可被勾選：已存在的項目只有在「同時更新已存在的紀錄」時才能勾；貼上內容中的重複行不可勾 */
export function isPickable(i: PasteItem, updateExisting: boolean): boolean {
  return !i.duplicate && (i.action !== 'existing' || updateExisting);
}

export const defaultPicked = (items: PasteItem[]): ReadonlySet<number> =>
  new Set(items.filter(isDefaultPicked).map((i) => i.lineNo));

/** 全選：所有可勾選項目（含暫時性） */
export const pickAll = (items: PasteItem[], updateExisting: boolean): ReadonlySet<number> =>
  new Set(items.filter((i) => isPickable(i, updateExisting)).map((i) => i.lineNo));

/** 只選非暫時性 */
export const pickNonTemp = (items: PasteItem[], updateExisting: boolean): ReadonlySet<number> =>
  new Set(items.filter((i) => isPickable(i, updateExisting) && !i.isTemp).map((i) => i.lineNo));

export const pickNone = (): ReadonlySet<number> => new Set();

export function togglePick(picked: ReadonlySet<number>, lineNo: number): ReadonlySet<number> {
  const next = new Set(picked);
  if (next.has(lineNo)) next.delete(lineNo);
  else next.add(lineNo);
  return next;
}

/** 關閉「更新已存在」時，把已勾選的既有項目拿掉 */
export function dropUnpickable(
  items: PasteItem[],
  picked: ReadonlySet<number>,
  updateExisting: boolean,
): ReadonlySet<number> {
  const ok = new Set(items.filter((i) => isPickable(i, updateExisting)).map((i) => i.lineNo));
  return new Set([...picked].filter((n) => ok.has(n)));
}

/** 實際會送出的行號（依預覽順序） */
export const pickedLines = (items: PasteItem[], picked: ReadonlySet<number>, updateExisting: boolean) =>
  items.filter((i) => picked.has(i.lineNo) && isPickable(i, updateExisting)).map((i) => i.lineNo);

/** 中間省略：保留頭尾（路徑尾端最重要）；全文放 tooltip */
export function middleEllipsis(s: string, max = 56): string {
  if (s.length <= max || max < 8) return s;
  const keep = max - 1;
  const tail = Math.ceil(keep * 0.6);
  const head = keep - tail;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export type PasteTag = {
  label: string;
  tone: 'success' | 'neutral' | 'accent' | 'warning' | 'danger';
  title?: string;
};

export function pasteTags(i: PasteItem): PasteTag[] {
  const tags: PasteTag[] = [];
  if (i.action === 'new') tags.push({ label: '新增', tone: 'success' });
  else if (i.action === 'existing') tags.push({ label: '已存在', tone: 'neutral' });
  else
    tags.push({
      label: '可能搬動',
      tone: 'accent',
      title: i.recordPath ? `原路徑 ${i.recordPath}` : undefined,
    });
  if (i.duplicate)
    tags.push({ label: '重複', tone: 'neutral', title: '貼上內容中有相同路徑，只會登記第一筆' });
  if (i.isTemp)
    tags.push({
      label: '暫時性',
      tone: 'warning',
      title: `可能是暫時性 / 代理產生：${i.tempReasons.join('、')}`,
    });
  if (i.isLocked) tags.push({ label: '鎖定', tone: 'neutral', title: i.lockReason || undefined });
  if (i.isDetached) tags.push({ label: '分離 HEAD', tone: 'neutral' });
  if (i.isPrunable)
    tags.push({
      label: '可清理',
      tone: 'danger',
      title: i.prunableReason || '路徑已不存在，可用 git worktree prune 清理',
    });
  if (i.isBare) tags.push({ label: 'bare', tone: 'neutral' });
  return tags;
}

/** 登記後的 toast 文字 */
export const pasteSummary = (r: { created: number; updated: number; skipped: number }) =>
  `已登記 ${r.created + r.updated} 筆、略過 ${r.skipped} 筆`;
