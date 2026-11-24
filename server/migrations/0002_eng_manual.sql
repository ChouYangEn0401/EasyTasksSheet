-- 工程追蹤簡化版（手動輸入優先）：問題、worktree 紀錄、各電腦回報快照。
-- 只新增資料表，不動既有 repos / worktree_plans / worktree_snapshots（舊 TS 後端仍可開啟此 DB）。
CREATE TABLE `manual_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_id` integer,
	`url` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `manual_issues_status_idx` ON `manual_issues` (`status`);
--> statement-breakpoint
CREATE TABLE `worktree_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine` text NOT NULL,
	`path` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`owner_id` integer,
	`purpose` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `worktree_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine` text NOT NULL,
	`repo` text DEFAULT '' NOT NULL,
	`path` text NOT NULL,
	`branch` text,
	`head_sha` text,
	`is_dirty` integer DEFAULT false NOT NULL,
	`ahead` integer,
	`behind` integer,
	`last_commit_at` integer,
	`is_prunable` integer DEFAULT false NOT NULL,
	`is_merged` integer DEFAULT false NOT NULL,
	`reported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worktree_reports_machine_idx` ON `worktree_reports` (`machine`, `repo`);
