import { useState } from 'react';
import type { GithubLink } from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { Alert, Button, Dialog, Input } from '../../ui/index.ts';
import { useImportIssues, useSaveGithubLinks } from './api.ts';

type Row = GithubLink & { key: number };

let seq = 0;
const toRows = (links: GithubLink[]): Row[] => links.map((l) => ({ ...l, key: ++seq }));
const clean = (rows: Row[]): GithubLink[] =>
  rows
    .map((r) => ({ project: r.project.trim(), githubRepo: r.githubRepo.trim() }))
    .filter((r) => r.project || r.githubRepo);

/**
 * GitHub 連動（githubEnabled 時才出現）：專案 ↔ repo 對應（任何成員可編輯，整批儲存），
 * 已儲存的對應可「從 GitHub 匯入」開啟中的 issue（以 repo + 編號去重）。
 */
export function GithubDialog({
  links,
  listId,
  onClose,
}: {
  links: GithubLink[];
  listId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    toRows(links.length ? links : [{ project: '', githubRepo: '' }]),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSaveGithubLinks();
  const importIssues = useImportIssues();
  const dirty = JSON.stringify(clean(rows)) !== JSON.stringify(links);
  const set = (key: number, patch: Partial<GithubLink>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = () => {
    setError(null);
    setNotice(null);
    save.mutate(clean(rows), {
      onSuccess: (res) => {
        setRows(toRows(res.links.length ? res.links : [{ project: '', githubRepo: '' }]));
        setNotice('已儲存');
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const runImport = (project: string) => {
    setError(null);
    setNotice(null);
    importIssues.mutate(project, {
      onSuccess: (res) =>
        setNotice(
          `從 ${res.repo} 匯入 ${res.created} 筆` + (res.skipped ? `（${res.skipped} 筆已存在，略過）` : ''),
        ),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open
      size="md"
      title="GitHub 連動"
      dirty={dirty}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            關閉
          </Button>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={submit}>
            儲存連動
          </Button>
        </>
      }
    >
      <div className="eng-form">
        <p className="eng-dialog-text">
          把問題的「專案 / Repo」對應到 GitHub repo（<code>owner/name</code>）後，可匯入該 repo 開啟中的
          issue，或從問題的「⋯」選單在 GitHub 建立 issue。
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <ul className="eng-gh-links" aria-label="專案連動">
          {rows.map((r, idx) => {
            const saved = links.find((l) => l.project.toLowerCase() === r.project.trim().toLowerCase());
            const canImport = !dirty && saved != null;
            return (
              <li key={r.key} className="eng-gh-link">
                <Input
                  value={r.project}
                  maxLength={100}
                  list={listId}
                  placeholder="專案名稱"
                  aria-label={`第 ${idx + 1} 列的專案`}
                  onChange={(e) => set(r.key, { project: e.target.value })}
                />
                <span className="eng-text-tertiary" aria-hidden="true">
                  →
                </span>
                <Input
                  value={r.githubRepo}
                  maxLength={200}
                  placeholder="owner/name"
                  aria-label={`第 ${idx + 1} 列的 GitHub repo`}
                  onChange={(e) => set(r.key, { githubRepo: e.target.value })}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!canImport}
                  loading={importIssues.isPending && importIssues.variables === saved?.project}
                  onClick={() => saved && runImport(saved.project)}
                  title={canImport ? undefined : '先儲存連動'}
                >
                  從 GitHub 匯入
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="x"
                  aria-label={`移除第 ${idx + 1} 列`}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                />
              </li>
            );
          })}
        </ul>
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            onClick={() => setRows((rs) => [...rs, ...toRows([{ project: '', githubRepo: '' }])])}
          >
            新增連動
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
