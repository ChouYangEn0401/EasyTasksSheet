import type { GitIssue } from '../../../shared/eng.ts';

/**
 * Issue 來源（單一介面，可抽換為 Gitea / GitLab）。
 * 只讀取未關閉的 issue；slug 為 `owner/name`。
 */
export interface IssueSource {
  readonly name: string;
  /** 是否已設定存取 token；未設定時不呼叫 listOpenIssues，畫面顯示說明 */
  isConfigured(): boolean;
  listOpenIssues(slug: string): Promise<GitIssue[]>;
}

export class IssueSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueSourceError';
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type GitHubIssue = {
  number: number;
  title: string;
  html_url: string;
  updated_at: string | null;
  labels: (string | { name?: string | null })[];
  assignee: { login: string } | null;
  pull_request?: unknown;
};

const MAX_PAGES = 5;

/** 解析 Link header 的 next 連結 */
function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** GitHub REST（唯讀 token）；排除 pull request，最多讀 5 頁（500 筆） */
export function createGitHubIssueSource(opts: {
  token: string | undefined;
  apiUrl: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}): IssueSource {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.apiUrl.replace(/\/$/, '');
  return {
    name: 'GitHub',
    isConfigured: () => !!opts.token,
    async listOpenIssues(slug) {
      if (!opts.token) throw new IssueSourceError('尚未設定存取 token');
      const [owner, name] = slug.split('/');
      let url: string | null =
        `${base}/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/issues` +
        '?state=open&per_page=100&sort=updated&direction=desc';
      const out: GitIssue[] = [];
      for (let page = 0; url && page < MAX_PAGES; page++) {
        let res: Response;
        try {
          res = await doFetch(url, {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${opts.token}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'tasks-sheets',
            },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
          });
        } catch (err) {
          const e = err as Error;
          throw new IssueSourceError(
            e.name === 'TimeoutError' ? '連線 GitHub 逾時' : `無法連線 GitHub（${e.message}）`,
          );
        }
        if (!res.ok) {
          const reason =
            res.status === 401
              ? 'token 無效或已過期'
              : res.status === 403
                ? '沒有權限或已達速率限制'
                : res.status === 404
                  ? `找不到 repo ${slug}（或 token 無權存取）`
                  : `HTTP ${res.status}`;
          throw new IssueSourceError(`GitHub 回應錯誤：${reason}`);
        }
        const items = (await res.json()) as GitHubIssue[];
        for (const i of items) {
          if (i.pull_request) continue;
          out.push({
            number: i.number,
            title: i.title,
            labels: i.labels
              .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
              .filter((l): l is string => !!l),
            assignee: i.assignee?.login ?? null,
            url: i.html_url,
            issueUpdatedAt: i.updated_at ? Date.parse(i.updated_at) : null,
          });
        }
        url = nextLink(res.headers.get('link'));
        // 只跟隨同源的分頁連結，避免把 token 送到其他主機
        if (url && new URL(url).origin !== new URL(base).origin) url = null;
      }
      return out;
    },
  };
}
