import { createElement, Fragment } from 'preact';
import { useMemo, useState } from 'preact/compat';
import { Link, useSearchParams } from '../../lib/router.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useUsers } from '../../lib/hooks.js';
import { Alert, Avatar, Button, EmptyState, ErrorState, Select, Spinner } from '../../ui/index.js';
import { ReportDialog } from './ReportDialog.js';
import { readTodoParam, sectionText } from './model.js';
import { AssignedSection, PinnedSection } from './TaskSections.js';
import { TodoSection } from './TodoSection.js';
import { WeekCard } from './WeekCard.js';

const USER_PARAM = 'user';

/**
 * 個人清單（/me，docs/design/personal.md）：指派給我的任務、我標記的任務、自由待辦。
 * `?user=<id>` 唯讀檢視其他成員的清單；三區各自載入與報錯。
 */
export function PersonalPage() {
  const me = useCurrentUser();
  // 匯報對話框：template = null 為一般格式（原本的「產生匯報報告」）；本週卡的按鈕帶模版與區間進來
  const [report, setReport] = useState({ open: false, template: null, preset: null });
  const openReport = (template = null, preset = null) => setReport({ open: true, template, preset });
  const [sp, setSp] = useSearchParams();
  const users = useUsers();
  const raw = sp.get(USER_PARAM);
  const requested = raw != null && /^\d+$/.test(raw) ? Number(raw) : raw == null ? null : NaN;

  const options = useMemo(() => {
    if (!me) return [];
    const others = (users.data ?? [])
      .filter((u) => u.isActive && u.id !== me.id)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
    return [
      {
        value: me.id,
        label: '我自己',
        leading: createElement(Avatar, { user: me, size: 'xs', tooltip: false }),
      },
      ...others.map((u) => ({
        value: u.id,
        label: u.displayName,
        leading: createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
      })),
    ];
  }, [me, users.data]);

  if (!me) return null;

  const viewingId = requested ?? me.id;
  const isSelf = viewingId === me.id;
  const target = isSelf ? me : users.data?.find((u) => u.id === viewingId);
  const notFound = !isSelf && (Number.isNaN(viewingId) || (users.data && (!target || !target.isActive)));

  const switchTo = (id) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('todo');
      if (id === me.id) next.delete(USER_PARAM);
      else next.set(USER_PARAM, String(id));
      return next;
    });

  const backLink = createElement(Link, { to: '/me', className: 'pl-link' }, '回到我的清單');

  if (notFound) {
    return createElement(
      'div',
      { className: 'pl-page' },
      createElement(EmptyState, {
        icon: 'user',
        title: '找不到這位成員',
        action: createElement(
          Button,
          { variant: 'secondary', onClick: () => switchTo(me.id) },
          '回到我的清單',
        ),
      }),
    );
  }

  // 檢視他人時先確認成員存在再查詢（避免對不存在的成員發出請求）
  if (!isSelf && !target) {
    if (users.isError)
      return createElement(ErrorState, { error: users.error, onRetry: () => void users.refetch() });
    return createElement(
      'div',
      { className: 'pl-page', 'aria-busy': 'true' },
      createElement(Spinner, { size: 20, label: '載入中' }),
    );
  }

  const name = isSelf ? null : (target?.displayName ?? '成員');
  const t = sectionText(name);

  return createElement(
    'div',
    { className: 'pl-page', 'data-inspector': readTodoParam(sp) != null || undefined },
    createElement(
      'div',
      { className: 'pl-head' },
      !isSelf &&
        createElement(
          Alert,
          { tone: 'info', className: 'pl-readonly', action: backLink },
          '正在檢視 ',
          name,
          ' 的清單（唯讀）',
        ),
      createElement(
        'div',
        { className: 'pl-head-actions' },
        createElement(
          Button,
          { variant: 'secondary', icon: 'list', onClick: () => openReport() },
          '產生匯報報告',
        ),
        createElement(
          'div',
          { className: 'pl-switch' },
          createElement('span', { className: 'pl-switch-label', 'aria-hidden': 'true' }, '檢視：'),
          createElement(Select, {
            'aria-label': '檢視成員的清單',
            className: 'pl-switch-select',
            align: 'end',
            placeholder: name ?? '我自己',
            options: options,
            value: viewingId,
            onChange: switchTo,
          }),
        ),
      ),
    ),
    createElement(ReportDialog, {
      open: report.open,
      onClose: () => setReport((r) => ({ ...r, open: false })),
      userId: viewingId,
      memberName: name,
      selfName: me.displayName,
      initialTemplate: report.template,
      initialPreset: report.preset,
    }),
    createElement(WeekCard, { key: `week-${viewingId}`, userId: viewingId, onReport: openReport }),
    createElement(
      'div',
      { className: 'pl-grid', key: viewingId },
      createElement(
        'div',
        { className: 'pl-col' },
        createElement(AssignedSection, {
          userId: viewingId,
          text: { title: t.assigned, empty: t.assignedEmpty },
        }),
        createElement(PinnedSection, {
          userId: viewingId,
          text: {
            title: t.pinned,
            empty: t.pinnedEmpty,
            emptyDesc: isSelf ? '在任務上點書籤圖示即可加入' : undefined,
          },
        }),
      ),
      createElement(TodoSection, {
        userId: viewingId,
        readOnly: !isSelf,
        text: {
          title: t.todos,
          empty: t.todosEmpty,
          emptyDesc: isSelf ? '只有你能修改這份清單' : undefined,
        },
      }),
    ),
  );
}
