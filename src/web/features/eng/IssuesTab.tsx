import type { GitIssue, IssuesResponse } from '../../../shared/eng.ts';
import { errorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  Tooltip,
  UpdatedAt,
} from '../../ui/index.ts';
import { ExternalIcon } from './bits.tsx';
import { useIsWide } from './media.ts';

function Labels({ labels }: { labels: string[] }) {
  const max = useIsWide() ? 3 : 2;
  const shown = labels.slice(0, max);
  const rest = labels.slice(max);
  return (
    <span className="eng-labels">
      {shown.map((l) => (
        <Badge key={l}>{l}</Badge>
      ))}
      {rest.length > 0 && (
        <Tooltip content={rest.join('、')}>
          <span tabIndex={0} aria-label={`另外 ${rest.length} 個標籤：${rest.join('、')}`}>
            <Badge>+{rest.length}</Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

function IssueRow({ issue }: { issue: GitIssue }) {
  return (
    <tr>
      <td className="eng-col-num">#{issue.number}</td>
      <td className="eng-col-title">
        <a className="eng-issue-link" href={issue.url} target="_blank" rel="noopener noreferrer">
          {issue.title}
        </a>
      </td>
      <td>
        <Labels labels={issue.labels} />
      </td>
      <td className="eng-text-secondary">{issue.assignee ? `@${issue.assignee}` : '—'}</td>
      <td>
        {issue.issueUpdatedAt != null ? (
          <UpdatedAt at={issue.issueUpdatedAt} />
        ) : (
          <span className="eng-text-tertiary">—</span>
        )}
      </td>
      <td className="eng-col-action">
        <a
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon"
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在來源網站開啟 #${issue.number}`}
        >
          <ExternalIcon />
        </a>
      </td>
    </tr>
  );
}

export function SkeletonRows({ rows, cols }: { rows: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j}>
              <Skeleton width={j === 1 ? '80%' : '60%'} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Issues 分頁（design §2） */
export function IssuesTab({
  query,
  refreshing,
  onRefresh,
}: {
  query: { data?: IssuesResponse; isPending: boolean; error: unknown; refetch: () => void };
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const data = query.data;
  const refreshBtn = (
    <Button variant="secondary" size="sm" icon="refresh" loading={refreshing} onClick={onRefresh}>
      {refreshing ? '同步中…' : '重新整理'}
    </Button>
  );

  if (data && !data.configured) {
    return (
      <EmptyState
        icon="key"
        title="尚未設定 issue 來源"
        description="請管理員在伺服器設定存取 token（見 .env.example）後重新啟動。"
      />
    );
  }
  if (data && !data.remoteSlug) {
    return <EmptyState icon="branch" title="此 repo 未設定遠端來源" />;
  }
  if (!data && query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  if (data?.error && data.fetchedAt == null) {
    return <ErrorState title="同步失敗" error={new Error(data.error.message)} onRetry={onRefresh} />;
  }

  return (
    <section className="eng-section" aria-label="Issues">
      <div className="eng-toolbar">
        <span className="eng-text-secondary eng-sync">
          {data?.fetchedAt != null ? (
            <>
              上次同步 <UpdatedAt at={data.fetchedAt} />
            </>
          ) : data ? (
            '尚未同步'
          ) : (
            <Skeleton width={120} />
          )}
        </span>
        <span className="eng-toolbar-end">{refreshBtn}</span>
      </div>
      {data?.error && data.fetchedAt != null && (
        <Alert
          tone="warning"
          action={
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
              重試
            </Button>
          }
        >
          同步失敗，目前顯示的是 {formatDateTime(data.fetchedAt)} 的資料（{data.error.message}）
        </Alert>
      )}
      {query.error != null && data && <Alert tone="warning">無法更新清單：{errorMessage(query.error)}</Alert>}
      {data && data.issues.length === 0 ? (
        <div className="eng-card">
          <EmptyState icon="checkCircle" title="沒有未處理的 issue" />
        </div>
      ) : (
        <div className="eng-card eng-scroll">
          <table className="eng-table eng-table--issues">
            <thead>
              <tr>
                <th scope="col" className="eng-col-num">
                  編號
                </th>
                <th scope="col">標題</th>
                <th scope="col">標籤</th>
                <th scope="col">負責人</th>
                <th scope="col">更新</th>
                <th scope="col" className="eng-col-action">
                  <span className="sr-only">連結</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data ? (
                data.issues.map((i) => <IssueRow key={i.number} issue={i} />)
              ) : (
                <SkeletonRows rows={6} cols={6} />
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
