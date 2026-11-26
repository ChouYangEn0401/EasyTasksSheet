import { taskSpan } from './timeline.js';

export const GROUP_OPTIONS = [
  { value: 'none', label: '不分組' },
  { value: 'project', label: '專案' },
  { value: 'assignee', label: '負責人' },
];

export function parseGroupBy(raw) {
  return raw === 'none' || raw === 'project' ? raw : 'assignee';
}

const byStart = (a, b) => (taskSpan(a)?.start ?? 0) - (taskSpan(b)?.start ?? 0) || a.id - b.id;

/**
 * 依分組方式切出群組（只放已排程的任務；未排程者由呼叫端另列）。
 * 負責人分組：members 依給定順序全部列出（沒有排程任務的成員仍有群組列），「未指派」排最後且僅在有任務時出現；
 * members 以外但有任務的負責人（如停用成員）接在成員後面。
 */
export function buildGroups(tasks, groupBy, ctx) {
  const scheduled = tasks.filter((t) => taskSpan(t)).sort(byStart);
  if (groupBy === 'none')
    return [{ key: 'all', kind: 'all', label: '全部任務', refId: null, tasks: scheduled }];

  if (groupBy === 'project') {
    const map = new Map();
    for (const t of scheduled) map.set(t.projectId, [...(map.get(t.projectId) ?? []), t]);
    const groups = [];
    for (const p of ctx.projects) {
      const list = map.get(p.id);
      if (!list) continue;
      groups.push({
        key: `p${p.id}`,
        kind: 'project',
        label: p.name,
        refId: p.id,
        color: p.color,
        tasks: list,
      });
      map.delete(p.id);
    }
    for (const [id, list] of map)
      groups.push({ key: `p${id}`, kind: 'project', label: `專案 #${id}`, refId: id, tasks: list });
    return groups;
  }

  const map = new Map();
  for (const t of scheduled) map.set(t.assigneeId, [...(map.get(t.assigneeId) ?? []), t]);
  const groups = ctx.members.map((m) => ({
    key: `u${m.id}`,
    kind: 'user',
    label: m.displayName,
    refId: m.id,
    tasks: map.get(m.id) ?? [],
  }));
  const listed = new Set(ctx.members.map((m) => m.id));
  for (const [id, list] of map) {
    if (id == null || listed.has(id)) continue;
    groups.push({
      key: `u${id}`,
      kind: 'user',
      label: ctx.userName?.(id) ?? `成員 #${id}`,
      refId: id,
      tasks: list,
    });
  }
  const none = map.get(null);
  if (none?.length)
    groups.push({ key: 'none', kind: 'unassigned', label: '未指派', refId: null, tasks: none });
  return groups;
}

/** 群組的起訖（最早開始到最晚到期） */
export function groupSpan(tasks) {
  let span = null;
  for (const t of tasks) {
    const s = taskSpan(t);
    if (!s) continue;
    span = span ? { start: Math.min(span.start, s.start), end: Math.max(span.end, s.end) } : { ...s };
  }
  return span;
}
