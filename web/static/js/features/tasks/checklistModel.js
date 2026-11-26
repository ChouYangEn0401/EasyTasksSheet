/**
 * 任務待辦清單的純邏輯（不碰 DOM / React）：型別、進度、排序值、貼上文字解析。
 * 規格見 docs/design/task-list.md「待辦清單」。
 */

/** 與後端一致的上限 */
export const MAX_BATCH = 100;
export const MAX_TEXT = 500;
export const MAX_PER_TASK = 500;

// ── 進度 ───────────────────────────────────────────

export function progressOf(total, done) {
  const t = Math.max(0, total);
  const d = Math.min(Math.max(0, done), t);
  return { total: t, done: d, percent: t === 0 ? 0 : Math.round((d / t) * 100), complete: t > 0 && d === t };
}

export function progressOfItems(items) {
  return progressOf(items.length, items.filter((i) => i.isDone).length);
}

/** 列表 / 看板徽章用：沒有清單時回傳 null（不顯示） */
export function badgeInfo(task) {
  const total = task.checklistTotal ?? 0;
  if (total <= 0) return null;
  const p = progressOf(total, task.checklistDone ?? 0);
  return { ...p, text: `${p.done}/${p.total}`, label: `待辦清單 ${p.done}/${p.total} 完成` };
}

// ── 排序 ───────────────────────────────────────────

/** 依 sortOrder（同值依 id）排序，與後端 `ORDER BY sort_order, id` 一致 */
export function sortItems(items) {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/**
 * 把 list[from] 移到 to 之後的排序值：取新相鄰兩項的中間值；放在最前 / 最後則 -1 / +1。
 * list 須已排序；from === to 時回傳原值。
 */
export function sortOrderForMove(list, from, to) {
  const rest = list.filter((_, i) => i !== from);
  const prev = rest[to - 1];
  const next = rest[to];
  if (prev && next) return (prev.sortOrder + next.sortOrder) / 2;
  if (prev) return prev.sortOrder + 1;
  if (next) return next.sortOrder - 1;
  return list[from]?.sortOrder ?? 1;
}

/** 在 afterOrder 之後插入新項目的排序值（afterOrder = null 表示插到最前面）；list 為目前全部項目 */
export function sortOrderAfter(list, afterOrder) {
  const ordered = [...list].sort((a, b) => a.sortOrder - b.sortOrder);
  if (afterOrder == null) return ordered.length ? ordered[0].sortOrder - 1 : 1;
  const next = ordered.find((i) => i.sortOrder > afterOrder);
  return next ? (afterOrder + next.sortOrder) / 2 : afterOrder + 1;
}

/** 排在最後的排序值 */
export function sortOrderLast(list) {
  return list.reduce((m, i) => Math.max(m, i.sortOrder), 0) + 1;
}

// ── 貼上文字解析 ─────────────────────────────────────

const CHECKBOX = /^\s*(?:[-*+•]\s*)?\[([ xX✓✔])\]\s*/;
const BULLET = /^\s*[-*+•‧·]\s+/;
const NUMBERED = /^\s*\d{1,4}(?:[.)]\s+|、\s*)/;
const UNICODE_BOX = /^\s*([☐☑☒✅□■])\s*/;

/** 單行解析；空白 / 只有標記時回傳 null */
export function parseLine(line) {
  if (/^\s*(?:[-*+•‧·]|\d{1,4}[.)、])\s*$/.test(line)) return null; // 只有標記
  let rest = line;
  let isDone = false;
  let m;
  if ((m = CHECKBOX.exec(rest))) {
    isDone = m[1] !== ' ';
    rest = rest.slice(m[0].length);
  } else if ((m = UNICODE_BOX.exec(rest))) {
    isDone = m[1] === '☑' || m[1] === '☒' || m[1] === '✅';
    rest = rest.slice(m[0].length);
  } else if ((m = BULLET.exec(rest))) {
    rest = rest.slice(m[0].length);
    // 項目符號後面還跟著核取方塊：「- [ ] x」已由上一支處理；這裡處理「- ☐ x」
    const box = UNICODE_BOX.exec(rest);
    if (box) {
      isDone = box[1] === '☑' || box[1] === '☒' || box[1] === '✅';
      rest = rest.slice(box[0].length);
    }
  } else if ((m = NUMBERED.exec(rest))) {
    rest = rest.slice(m[0].length);
    const box = CHECKBOX.exec(rest);
    if (box) {
      isDone = box[1] !== ' ';
      rest = rest.slice(box[0].length);
    }
  }
  const text = rest.trim().replace(/\s+/g, ' ');
  return text ? { text, isDone } : null;
}

/**
 * 解析貼上的 Markdown / 純文字清單：每行一項；辨識 `- [ ] x`、`- [x] x`、`* x`、`1. x`、`☐ x`；
 * 縮排與空行忽略（縮排的子項目攤平成同層）；超過 maxItems 的行數記在 overflow，過長文字截斷為 MAX_TEXT。
 */
export function parseChecklistText(raw, maxItems = MAX_BATCH) {
  const items = [];
  let overflow = 0;
  let trimmed = 0;
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (items.length >= maxItems) {
      overflow += 1;
      continue;
    }
    if ([...parsed.text].length > MAX_TEXT) {
      parsed.text = [...parsed.text].slice(0, MAX_TEXT).join('');
      trimmed += 1;
    }
    items.push(parsed);
  }
  return { items, overflow, trimmed };
}

/** 貼上的內容是否值得攔截並拆項（多行且解析出 2 項以上） */
export function shouldSplitPaste(raw) {
  if (!/[\r\n]/.test(raw.replace(/[\r\n]+$/, ''))) return false;
  return parseChecklistText(raw).items.length >= 2;
}

export function pasteSummary(r) {
  const done = r.items.filter((i) => i.isDone).length;
  const parts = [`將建立 ${r.items.length} 項`];
  if (done > 0) parts.push(`其中 ${done} 項已勾選`);
  return parts.join('，');
}
