import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useCurrentUser } from '../../lib/auth.ts';
import { useUsers } from '../../lib/hooks.ts';
import {
  Alert,
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Select,
  Spinner,
  type SelectOption,
} from '../../ui/index.ts';
import { sectionText } from './model.ts';
import { AssignedSection, PinnedSection } from './TaskSections.tsx';
import { TodoSection } from './TodoSection.tsx';
import './personal.css';

const USER_PARAM = 'user';

/**
 * 個人清單（/me，docs/design/personal.md）：指派給我的任務、我標記的任務、自由待辦。
 * `?user=<id>` 唯讀檢視其他成員的清單；三區各自載入與報錯。
 */
export function PersonalPage() {
  const me = useCurrentUser();
  const [sp, setSp] = useSearchParams();
  const users = useUsers();
  const raw = sp.get(USER_PARAM);
  const requested = raw != null && /^\d+$/.test(raw) ? Number(raw) : raw == null ? null : NaN;

  const options = useMemo<SelectOption<number>[]>(() => {
    if (!me) return [];
    const others = (users.data ?? [])
      .filter((u) => u.isActive && u.id !== me.id)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
    return [
      { value: me.id, label: '我自己', leading: <Avatar user={me} size="xs" tooltip={false} /> },
      ...others.map((u) => ({
        value: u.id,
        label: u.displayName,
        leading: <Avatar user={u} size="xs" tooltip={false} />,
      })),
    ];
  }, [me, users.data]);

  if (!me) return null;

  const viewingId = requested ?? me.id;
  const isSelf = viewingId === me.id;
  const target = isSelf ? me : users.data?.find((u) => u.id === viewingId);
  const notFound = !isSelf && (Number.isNaN(viewingId) || (users.data && (!target || !target.isActive)));

  const switchTo = (id: number) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (id === me.id) next.delete(USER_PARAM);
      else next.set(USER_PARAM, String(id));
      return next;
    });

  const backLink = (
    <Link to="/me" className="pl-link">
      回到我的清單
    </Link>
  );

  if (notFound) {
    return (
      <div className="pl-page">
        <EmptyState
          icon="user"
          title="找不到這位成員"
          action={
            <Button variant="secondary" onClick={() => switchTo(me.id)}>
              回到我的清單
            </Button>
          }
        />
      </div>
    );
  }

  // 檢視他人時先確認成員存在再查詢（避免對不存在的成員發出請求）
  if (!isSelf && !target) {
    if (users.isError) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
    return (
      <div className="pl-page" aria-busy="true">
        <Spinner size={20} label="載入中" />
      </div>
    );
  }

  const name = isSelf ? null : (target?.displayName ?? '成員');
  const t = sectionText(name);

  return (
    <div className="pl-page">
      <div className="pl-head">
        {!isSelf && (
          <Alert tone="info" className="pl-readonly" action={backLink}>
            正在檢視 {name} 的清單（唯讀）
          </Alert>
        )}
        <div className="pl-switch">
          <span className="pl-switch-label" aria-hidden="true">
            檢視：
          </span>
          <Select
            aria-label="檢視成員的清單"
            className="pl-switch-select"
            align="end"
            placeholder={name ?? '我自己'}
            options={options}
            value={viewingId}
            onChange={switchTo}
          />
        </div>
      </div>
      <div className="pl-grid" key={viewingId}>
        <div className="pl-col">
          <AssignedSection userId={viewingId} text={{ title: t.assigned, empty: t.assignedEmpty }} />
          <PinnedSection
            userId={viewingId}
            text={{
              title: t.pinned,
              empty: t.pinnedEmpty,
              emptyDesc: isSelf ? '在任務上點書籤圖示即可加入' : undefined,
            }}
          />
        </div>
        <TodoSection
          userId={viewingId}
          readOnly={!isSelf}
          text={{
            title: t.todos,
            empty: t.todosEmpty,
            emptyDesc: isSelf ? '只有你能修改這份清單' : undefined,
          }}
        />
      </div>
    </div>
  );
}
