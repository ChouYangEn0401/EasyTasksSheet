// 工程追蹤（手動輸入優先；Python 後端 server/app/features/eng.py、eng_status.py）。

// ── 可自訂狀態（GET /api/eng/statuses） ─────────────────────

export const ISSUE_CATEGORIES = ['open', 'closed'];
export const WORKTREE_CATEGORIES = ['active', 'idle', 'attention', 'done'];

export const ENG_CATEGORY_LABELS = {
  open: '未結案',
  closed: '已結案',
  active: '使用中',
  idle: '閒置',
  attention: '需處理',
  done: '已結束',
};

// ── 問題 ─────────────────────────────────────────────────────

/** eng_statuses（kind = issue）的 key */

/** 專案連動：問題的「專案 / Repo」名稱（不分大小寫）→ GitHub owner/name */

/** GET /api/eng/issues */

// ── 附件與連結預覽 ─────────────────────────────────────────

/** 網頁 metadata 預覽（不含整頁截圖） */

/** POST /api/eng/issues/sync（body：{} 或 { id }） */

/** POST /api/eng/issues/import（body：{ project }） */

/** PUT /api/eng/github-links（body：{ links }，整批取代）；POST /issues/:id/publish 則回傳 ManualIssue */

/** POST /api/eng/issues（title 必填）；PATCH 只送改動欄位 */

// ── Worktree 紀錄 ────────────────────────────────────────────

/** eng_statuses（kind = worktree）的 key */

/** POST /api/eng/worktree-records（machine、path 必填）；PATCH 只送改動欄位 */

/** 各電腦以 scripts/report_worktrees.py 回報的快照（僅供參考；不見的項目只標 missingSince，不刪除） */

/** 被攔下待確認的可疑回報：empty = 空清單、drop = 筆數驟減 */

/**
 * 紀錄的提示：
 * - missing：該電腦有回報，但回報中從未出現此路徑
 * - vanished：上次回報有看到、最新回報找不到（lastSeenAt）
 * - moved：路徑不同但分支與 HEAD 相同的未登記項目（moveTo）→ 可能是搬動 / 改名
 */

/** GET /api/eng/worktrees */

/** GET /api/eng/worktree-records/trash */

/** POST /api/eng/worktrees/scan（預覽，不寫入） */

/** POST /api/eng/worktrees/scan/apply */

// ── 貼上 git worktree list 輸出（POST /api/eng/worktrees/paste/preview、/apply） ──
