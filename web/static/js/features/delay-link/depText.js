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
