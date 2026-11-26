import { useMemo } from 'preact/compat';
import { api } from '../../lib/api.js';
import { emptyFilters } from '../../lib/filters.js';
import { useProjectsById, useStatusesById, useTasks } from '../../lib/hooks.js';
import { useQuery } from '../../lib/query.js';
import { personalKeys, useReport } from './api.js';
import { buildTemplateModel, decisionItems, renderTemplate, templateSummary } from './reportTemplates.js';

/** 設計決議最多讀幾個任務的討論（每個一次請求） */
const MAX_DECISION_COMMENTS = 10;

/** 討論串 → 內文（新→舊；根訊息＋預覽回覆） */
function threadBodies(res) {
  const out = [];
  for (const th of res?.threads ?? []) {
    for (const r of [...(th.replies ?? [])].reverse()) if (r.body) out.push(r.body);
    if (th.body) out.push(th.body);
  }
  return out;
}

/**
 * 匯報模版的資料：任務清單（/api/tasks?assignee=…）＋狀態＋專案 → 模版模型 → { text, html, md }。
 * enabled = false（一般格式）時不發請求。自由待辦只對「對話框的成員」讀 /api/personal/report。
 *
 * @param {object} p
 * @param {boolean} p.enabled
 * @param {string} p.template      worklog / weekly / pl / decision
 * @param {Array} p.members        [{ id, name }]
 * @param {number} p.userId        對話框的成員（自由待辦來源）
 * @param {{from:string,to:string}} p.range
 * @param {string} p.today
 * @param {object} p.opts          DEFAULT_TEMPLATE_OPTIONS 形狀
 */
export function useTemplateOutput({ enabled, template, members, userId, range, today, opts, rangeOk }) {
  const ids = useMemo(() => [...new Set(members.map((m) => m.id))].sort((a, b) => a - b), [members]);
  const filters = useMemo(() => ({ ...emptyFilters(), assignee: ids }), [ids]);
  const tasksQ = useTasks(filters, { enabled: enabled && ids.length > 0 });
  const statuses = useStatusesById();
  const projects = useProjectsById();
  const wantTodos = enabled && rangeOk && opts.includeTodos && template !== 'decision';
  const reportQ = useReport(userId, range, [], wantTodos);

  const ready = enabled && rangeOk && tasksQ.data != null && statuses.size > 0;
  const todos = useMemo(
    () => (wantTodos && reportQ.data ? { [userId]: reportQ.data.completedTodos ?? [] } : {}),
    [wantTodos, reportQ.data, userId],
  );
  const base = useMemo(
    () =>
      ready
        ? buildTemplateModel({
            tasks: tasksQ.data,
            statuses,
            projects,
            members,
            from: range.from,
            to: range.to,
            today,
            todos,
          })
        : null,
    [ready, tasksQ.data, statuses, projects, members, range.from, range.to, today, todos],
  );

  // 設計決議：讀候選任務的討論，抓「決議／理由／替代方案／影響」
  const decisionIds = useMemo(
    () =>
      template === 'decision' && base
        ? base.members
            .flatMap((m) => decisionItems(m, base))
            .map((it) => it.id)
            .slice(0, MAX_DECISION_COMMENTS)
        : [],
    [template, base],
  );
  const commentsQ = useQuery({
    queryKey: [...personalKeys.all, 'tpl-comments', decisionIds.join(',')],
    queryFn: async ({ signal }) => {
      const pairs = await Promise.all(
        decisionIds.map(async (id) => {
          try {
            return [id, threadBodies(await api.get(`/tasks/${id}/comments?limit=20`, { signal }))];
          } catch {
            return [id, []]; // 讀不到討論就只用描述
          }
        }),
      );
      return Object.fromEntries(pairs);
    },
    enabled: enabled && decisionIds.length > 0,
    staleTime: 30_000,
  });

  const model = useMemo(() => {
    if (!base) return null;
    if (template !== 'decision' || !commentsQ.data) return base;
    return buildTemplateModel({
      tasks: tasksQ.data,
      statuses,
      projects,
      members,
      from: range.from,
      to: range.to,
      today,
      todos,
      comments: commentsQ.data,
    });
  }, [base, template, commentsQ.data, tasksQ.data, statuses, projects, members, range.from, range.to, today, todos]);

  const output = useMemo(() => (model ? renderTemplate(template, model, opts) : null), [model, template, opts]);
  return {
    model,
    output,
    summary: model ? templateSummary(model) : '',
    loading: enabled && rangeOk && !model && !tasksQ.isError,
    error: tasksQ.isError ? tasksQ.error : null,
    refetch: () => void tasksQ.refetch(),
  };
}
