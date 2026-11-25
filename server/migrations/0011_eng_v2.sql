-- 工程追蹤 v2（feat/eng-v2；docs/design/eng-tracking.md §自訂狀態、§掃描、§安全回報）
-- (A) 可自訂狀態：eng_statuses（kind = issue | worktree；key 為穩定識別，內建值沿用既有字串，既有資料不需改）
CREATE TABLE `eng_statuses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`kind` text NOT NULL CHECK (`kind` IN ('issue', 'worktree')),
	`key` text NOT NULL,
	`label` text NOT NULL,
	`color` text DEFAULT 'gray' NOT NULL,
	`category` text NOT NULL,
	`sort_order` real DEFAULT 0 NOT NULL,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eng_statuses_kind_key_uq` ON `eng_statuses` (`kind`, `key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `eng_statuses_uid_uq` ON `eng_statuses` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `eng_statuses_uid_ai` AFTER INSERT ON `eng_statuses` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `eng_statuses` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
-- 內建狀態：既有值（open / doing / closed；active / idle / merged / lost / cleaned）＋ 新增的預設值
INSERT INTO `eng_statuses` (`kind`, `key`, `label`, `color`, `category`, `sort_order`, `is_builtin`, `created_at`, `updated_at`) VALUES
	('issue', 'open', '未處理', 'yellow', 'open', 1, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('issue', 'doing', '處理中', 'blue', 'open', 2, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('issue', 'blocked', '卡住', 'red', 'open', 3, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('issue', 'deferred', '延後', 'gray', 'open', 4, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('issue', 'closed', '已結案', 'green', 'closed', 5, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('issue', 'wontfix', '不處理', 'gray', 'closed', 6, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'active', '使用中', 'green', 'active', 1, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'idle', '閒置', 'gray', 'idle', 2, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'merged', '已合併待清理', 'purple', 'attention', 3, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'broken', '損毀', 'red', 'attention', 4, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'tech_debt', '技術債', 'orange', 'attention', 5, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'legacy', '舊版保留', 'teal', 'idle', 6, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'unknown', '未知', 'gray', 'attention', 7, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'lost', '已遺失', 'red', 'done', 8, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000),
	('worktree', 'cleaned', '已清理', 'gray', 'done', 9, 1, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000);
--> statement-breakpoint
-- 既有資料中若有不在內建清單的值（理論上不會），補成自訂狀態，舊資料仍可顯示
INSERT INTO `eng_statuses` (`kind`, `key`, `label`, `color`, `category`, `sort_order`, `created_at`, `updated_at`)
	SELECT DISTINCT 'issue', `status`, `status`, 'gray', 'open', 100, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000
	FROM `manual_issues` WHERE `status` NOT IN (SELECT `key` FROM `eng_statuses` WHERE `kind` = 'issue');
--> statement-breakpoint
INSERT INTO `eng_statuses` (`kind`, `key`, `label`, `color`, `category`, `sort_order`, `created_at`, `updated_at`)
	SELECT DISTINCT 'worktree', `status`, `status`, 'gray', 'active', 100, CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000
	FROM `worktree_records` WHERE `status` NOT IN (SELECT `key` FROM `eng_statuses` WHERE `kind` = 'worktree');
--> statement-breakpoint
-- (B)(C) worktree 紀錄：電腦識別碼、來源（manual / report / scan）、repo、HEAD（搬動比對用）、軟刪除（回收區）
ALTER TABLE `worktree_records` ADD `machine_id` text;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `source` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `repo` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `head_sha` text;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `deleted_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
-- (C) 回報快照：以 machine_id 為鍵（舊回報沒有 id → 以名稱暫代）；最新回報找不到的列只標 missing_since，不刪除
ALTER TABLE `worktree_reports` ADD `machine_id` text;
--> statement-breakpoint
ALTER TABLE `worktree_reports` ADD `missing_since` integer;
--> statement-breakpoint
-- 每台電腦 × repo 的回報狀態：最後回報時間、目前快照筆數、被攔下待確認的可疑回報
CREATE TABLE `worktree_report_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine_key` text NOT NULL,
	`machine_id` text,
	`machine` text NOT NULL,
	`repo` text DEFAULT '' NOT NULL,
	`last_report_at` integer NOT NULL,
	`last_applied_at` integer,
	`pending_json` text,
	`pending_reason` text,
	`pending_count` integer,
	`pending_previous` integer,
	`pending_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_report_sources_key_uq` ON `worktree_report_sources` (`machine_key`, `repo`);
--> statement-breakpoint
INSERT INTO `worktree_report_sources` (`machine_key`, `machine`, `repo`, `last_report_at`, `last_applied_at`)
	SELECT 'name:' || lower(trim(`machine`)), max(`machine`), `repo`, max(`reported_at`), max(`reported_at`)
	FROM `worktree_reports` GROUP BY lower(trim(`machine`)), `repo`;
