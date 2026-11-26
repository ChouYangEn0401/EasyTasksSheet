/**
 * 依賴 / 延遲鏈的顯示文案（純函式，方便單元測試）。
 * 語氣原則（docs/product-principles.md、docs/design/delay-link.md §語氣）：中性、緩和，
 * 用「等待中」「前置任務」「預計延後」，不指責個人、不用紅色警示。
 */

/** YYYY-MM-DD → 12/20（不同年份時 2027/01/03） */
export function shortDate(date, today) {
  if (!date) return '';
  const [y, m, d] = date.split('-');
  if (today && today.slice(0, 4) !== y) return `${y}/${m}/${d}`;
  return `${m}/${d}`;
}

/** 任務詳情依賴列的延後說明 */
export function delayPhrase(p, today) {
  if (p.unknownBlockerDate) return '對方尚未排程';
  if (p.delayDays != null && p.delayDays > 0)
    return `預計延後 ${p.delayDays} 天（到 ${shortDate(p.projectedEnd, today)}）`;
  if (p.delayDays === 0) return '預計可如期';
  if (p.projectedEnd) return `預計 ${shortDate(p.projectedEnd, today)} 完成`;
  return '';
}

/** 看板卡片底部的徽章文字（被擋住時） */
export function blockedBadgeText(p, today) {
  if (p.delayDays != null && p.delayDays > 0 && p.projectedEnd)
    return `等待中 · 預計延後 ${p.delayDays} 天 → ${shortDate(p.projectedEnd, today)}`;
  return '等待中';
}

/** 被擋住卡片的 Tooltip 說明 */
export function blockedTooltip(p, today) {
  const head = `正在等待 ${p.blockedByCount} 個前置任務完成`;
  if (p.delayDays == null || !p.projectedEnd) {
    return p.projectedEnd
      ? `${head}。依前置任務的時程，預計 ${shortDate(p.projectedEnd, today)} 完成`
      : `${head}`;
  }
  if (p.delayDays === 0) return `${head}。依前置任務的時程，仍可在到期日前完成`;
  return `${head}。依前置任務的時程，預計 ${shortDate(p.projectedEnd, today)} 完成（原定 ${shortDate(p.dueDate, today)}）`;
}

export const blocksBadgeText = (n) => `擋住 ${n}`;
export const blocksTooltip = (n) => `完成後，有 ${n} 個任務可以開始`;

/** 延遲鏈節點的延後徽章 */
export function nodeBadge(n, today) {
  if (n.isDone) return { tone: 'neutral', text: '已完成', label: '已完成' };
  if (n.unknownBlockerDate)
    return { tone: 'neutral', text: '待排程', label: '前置任務尚未排程，暫時無法推算' };
  if (n.delayDays != null && n.delayDays > 0)
    return { tone: 'warning', text: `+${n.delayDays} 天`, label: `預計延後 ${n.delayDays} 天` };
  if (n.delayDays === 0) return { tone: 'success', text: '準時', label: '預計可如期完成' };
  if (n.projectedEnd)
    return {
      tone: 'neutral',
      text: `預計 ${shortDate(n.projectedEnd, today)}`,
      label: '沒有到期日，僅顯示預計完成日',
    };
  return { tone: 'neutral', text: '待排程', label: '尚未設定日期' };
}

/** 延遲鏈頁頂部摘要 */
export function chainsSummary(chains) {
  if (chains.length === 0) return '目前沒有依賴鏈';
  const max = Math.max(0, ...chains.map((c) => c.summary.maxDelayDays));
  const head = `共 ${chains.length} 條依賴鏈`;
  return max > 0 ? `${head}・最長預計延後 ${max} 天` : `${head}・目前都可如期`;
}

/** 單條鏈的標題說明 */
export function chainCaption(s, today) {
  const parts = [`${s.nodeCount} 個任務`];
  if (s.finalProjectedEnd) parts.push(`預計 ${shortDate(s.finalProjectedEnd, today)} 全部完成`);
  parts.push(s.maxDelayDays > 0 ? `最多延後 ${s.maxDelayDays} 天` : '目前可如期');
  return parts.join('・');
}

export const lagLabel = (lag) => (lag > 0 ? `+${lag} 天` : '');

/* ── 相依區（任務抽屜三段鏈）與延遲鏈頁共用的純函式（docs/design/ui-refresh-2026-11-26.md §5） ── */

/** 兩個 YYYY-MM-DD 相差幾天（b − a）；任一為空回傳 null */
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** 逾期天數：未完成且到期日早於今天時為 今天 − 到期日，否則 0（「日期事實」，不是推算） */
export function overdueDays(dueDate, today, isDone = false) {
  if (isDone || !dueDate || !today || dueDate >= today) return 0;
  return Math.max(0, daysBetween(dueDate, today) ?? 0);
}

/**
 * 「目前等待」的前置任務：未完成的上游中，預計完成日（沒有就用到期日）最晚的那一條；
 * 相同再比預計延後天數，再相同取先出現的。沒有未完成的上游回傳 null。
 * items：GET /api/tasks/:id/dependencies 的 blockedBy。
 */
export function currentWaitId(items) {
  let best = null;
  for (const d of items ?? []) {
    if (d.task.isDone) continue;
    const end = d.projection?.projectedEnd ?? d.task.dueDate ?? '';
    const delay = d.projection?.delayDays ?? -1;
    if (!best || end > best.end || (end === best.end && delay > best.delay)) best = { id: d.id, end, delay };
  }
  return best ? best.id : null;
}

/**
 * 相依區每一列的狀態 pill（可能兩顆：逾期是日期事實、預計延後是推算，兩者並存）。
 * tone：overdue（紅，只用在日期事實）／delay（琥珀）／ok（綠）／unknown（中性）／done（中性）。
 * 延後那顆沿用 delayPhrase 的完整文字（含「（到 12/20）」）。
 */
export function rowStates(task, projection, today) {
  if (task.isDone) return [{ tone: 'done', text: '已完成' }];
  const out = [];
  const od = overdueDays(task.dueDate, today);
  if (od > 0) out.push({ tone: 'overdue', text: `逾期 ${od} 天` });
  const p = projection ?? {};
  if (p.unknownBlockerDate) out.push({ tone: 'unknown', text: '對方尚未排程' });
  else if (p.delayDays != null && p.delayDays > 0) out.push({ tone: 'delay', text: delayPhrase(p, today) });
  else if (od === 0) {
    if (p.delayDays === 0) out.push({ tone: 'ok', text: '預計可如期' });
    else if (p.projectedEnd && !task.dueDate) out.push({ tone: 'unknown', text: delayPhrase(p, today) });
    else if (!task.dueDate && !task.startDate) out.push({ tone: 'unknown', text: '未排程' });
  }
  return out;
}

/** 清單列／看板卡「擋著 N」的短字 */
export const blocksMarkText = (n) => `擋著 ${n}`;
/** 清單列／看板卡「被擋 N」的短字 */
export const blockedMarkText = (n) => `被擋 ${n}`;

/** 延遲鏈單條鏈的摘要數字（給 .dl-chain-stats） */
export function chainStats(chain, today) {
  const active = chain.nodes.filter((n) => !n.isDone);
  const byId = new Map(chain.nodes.map((n) => [n.id, n]));
  const firstWait = chain.summary.criticalPath.map((id) => byId.get(id)).find((n) => n && !n.isDone) ?? null;
  return {
    nodeCount: chain.summary.nodeCount,
    waitingCount: active.filter((n) => n.isBlocked).length,
    overdueCount: active.filter((n) => overdueDays(n.dueDate, today) > 0).length,
    maxDelayDays: chain.summary.maxDelayDays,
    finalProjectedEnd: chain.summary.finalProjectedEnd,
    currentWait: firstWait,
  };
}
