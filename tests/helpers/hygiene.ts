import { test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { E2E_USERS } from './e2eUsers.ts';

/**
 * E2E 資料衛生：讓每個 spec 結束時清掉「自己建立」的資料，不依賴檔名順序，也不影響後面的 spec。
 *
 * 做法：beforeAll 記下目前最大的任務 id / 各帳號最大的自由待辦 id（水位），afterAll 把水位之後新增的
 * 任務軟刪除、自由待辦刪除。單一 worker 下水位之後的資料必為本 spec 所建。
 * 軟刪除的任務會連同其依賴、留言、待辦清單、關聯、標記一起從所有檢視消失（資料列仍在 DB 內）。
 * 清理失敗（例如該 spec 改了帳號密碼）只忽略，不讓測試失敗。
 */

type WithId = { id: number };
const USERS = [E2E_USERS.admin, E2E_USERS.member] as const;

type Pw = PlaywrightWorkerArgs['playwright'];

async function open(pw: Pw, baseURL: string, user: { username: string; password: string }) {
  const ctx = await pw.request.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', {
    data: { username: user.username, password: user.password },
  });
  if (!res.ok()) {
    await ctx.dispose();
    return null;
  }
  return ctx;
}

const maxId = (rows: WithId[]) => rows.reduce((m, r) => Math.max(m, r.id), 0);

async function listIds(ctx: APIRequestContext, url: string): Promise<WithId[]> {
  const res = await ctx.get(url);
  return res.ok() ? ((await res.json()) as WithId[]) : [];
}

/** 在 spec 檔案最上層呼叫一次 */
export function useDataHygiene() {
  let baseURL = '';
  let taskMark = Number.MAX_SAFE_INTEGER; // 取不到水位就不清理
  const todoMark = new Map<string, number>();

  test.beforeAll(async ({ playwright }, testInfo) => {
    baseURL = String(testInfo.project.use.baseURL ?? '');
    try {
      const admin = await open(playwright, baseURL, E2E_USERS.admin);
      if (admin) {
        taskMark = maxId(await listIds(admin, '/api/tasks'));
        await admin.dispose();
      }
      for (const u of USERS) {
        const ctx = await open(playwright, baseURL, u);
        if (!ctx) continue;
        todoMark.set(u.username, maxId(await listIds(ctx, '/api/personal')));
        await ctx.dispose();
      }
    } catch {
      taskMark = Number.MAX_SAFE_INTEGER;
    }
  });

  test.afterAll(async ({ playwright }) => {
    try {
      const admin = await open(playwright, baseURL, E2E_USERS.admin);
      if (admin) {
        // 最多清三輪：刪除後重新列出，確認水位之後已沒有殘留（失敗的請求會印出警告，不讓測試失敗）
        for (let pass = 0; pass < 3; pass++) {
          const left = (await listIds(admin, '/api/tasks')).filter((t) => t.id > taskMark);
          if (left.length === 0) break;
          for (const t of left) {
            const res = await admin.delete(`/api/tasks/${t.id}`);
            if (!res.ok()) console.warn(`[hygiene] DELETE /api/tasks/${t.id} -> ${res.status()}`);
          }
        }
        await admin.dispose();
      }
      for (const u of USERS) {
        const ctx = await open(playwright, baseURL, u);
        if (!ctx) continue;
        const mark = todoMark.get(u.username) ?? Number.MAX_SAFE_INTEGER;
        for (const it of await listIds(ctx, '/api/personal')) {
          if (it.id > mark) await ctx.delete(`/api/personal/${it.id}`);
        }
        await ctx.dispose();
      }
    } catch {
      /* 清理是盡力而為 */
    }
  });
}
