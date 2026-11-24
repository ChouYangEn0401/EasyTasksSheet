import { useState, type FormEvent } from 'react';
import type { Repo } from '../../../shared/eng.ts';
import { errorMessage } from '../../lib/api.ts';
import { Alert, Button, Dialog, EmptyState, Field, Input, UpdatedAt } from '../../ui/index.ts';
import { useDeleteRepo, useSaveRepo } from './api.ts';

type Draft = { id?: number; name: string; localPath: string; remoteSlug: string };

const toDraft = (r?: Repo): Draft => ({
  id: r?.id,
  name: r?.name ?? '',
  localPath: r?.localPath ?? '',
  remoteSlug: r?.remoteSlug ?? '',
});

function RepoForm({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveRepo();
  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));
  const ready = form.name.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || save.isPending) return;
    setError(null);
    save.mutate(
      {
        id: form.id,
        name: form.name.trim(),
        localPath: form.localPath.trim() || null,
        remoteSlug: form.remoteSlug.trim() || null,
      },
      { onSuccess: onDone, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <form
      className="eng-form eng-repo-form"
      onSubmit={submit}
      aria-label={form.id ? '編輯 repo' : '新增 repo'}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="名稱">
        <Input
          value={form.name}
          maxLength={100}
          onChange={(e) => set({ name: e.target.value })}
          data-autofocus
        />
      </Field>
      <Field label="本機路徑" hint="server 上 repo 的路徑（server 會直接偵測 worktree）">
        <Input
          className="eng-mono"
          value={form.localPath}
          maxLength={500}
          placeholder="/srv/repos/tasks-sheets"
          onChange={(e) => set({ localPath: e.target.value })}
        />
      </Field>
      <Field label="遠端" hint="owner/name，用於讀取 issue">
        <Input
          className="eng-mono"
          value={form.remoteSlug}
          maxLength={200}
          placeholder="owner/name"
          onChange={(e) => set({ remoteSlug: e.target.value })}
        />
      </Field>
      <div className="eng-form-actions">
        <Button variant="secondary" onClick={onDone}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={!ready} loading={save.isPending}>
          儲存
        </Button>
      </div>
    </form>
  );
}

/** 管理 repo（僅管理員，design §4） */
export function RepoDialog({ repos, onClose }: { repos: Repo[]; onClose: () => void }) {
  const [editing, setEditing] = useState<Draft | null>(repos.length === 0 ? toDraft() : null);
  const [confirm, setConfirm] = useState<Repo | null>(null);
  const del = useDeleteRepo();

  return (
    <>
      <Dialog open size="md" onClose={onClose} title="管理 repo" dirty={editing != null}>
        {editing ? (
          <RepoForm key={editing.id ?? 'new'} initial={editing} onDone={() => setEditing(null)} />
        ) : (
          <div className="eng-repo-list">
            {repos.length === 0 ? (
              <EmptyState title="尚未登記任何 repo" />
            ) : (
              <ul>
                {repos.map((r) => (
                  <li key={r.id} className="eng-repo-item">
                    <div className="eng-repo-info">
                      <span className="eng-repo-name">{r.name}</span>
                      <span className="eng-path">{r.localPath ?? '（未設定本機路徑）'}</span>
                      <span className="eng-sub">
                        {r.remoteSlug ?? '未設定遠端'} · <UpdatedAt at={r.updatedAt} />
                      </span>
                    </div>
                    <span className="eng-repo-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(toDraft(r))}>
                        編輯
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(r)}>
                        刪除
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="secondary" icon="plus" onClick={() => setEditing(toDraft())}>
              新增 repo
            </Button>
          </div>
        )}
      </Dialog>
      {confirm && (
        <Dialog
          open
          size="sm"
          role="alertdialog"
          title={`刪除 repo「${confirm.name}」？`}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                loading={del.isPending}
                onClick={() => del.mutate(confirm.id, { onSuccess: () => setConfirm(null) })}
              >
                刪除
              </Button>
            </>
          }
        >
          {del.error != null && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
          <p className="eng-dialog-text">
            此 repo 的 worktree 安排、偵測結果與 issue 快取會一併刪除，不會變更磁碟上的檔案。
          </p>
        </Dialog>
      )}
    </>
  );
}
