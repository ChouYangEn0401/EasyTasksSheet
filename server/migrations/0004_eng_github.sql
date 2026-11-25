-- 工程追蹤：選配的 GitHub 連動（未設定 GITHUB_TOKEN 時這些欄位只由「連結」網址解析填入，不會連網）。
-- github_repo 存小寫的 owner/name；github_state / github_title 為上次同步時 GitHub 端的值（用來判斷「GitHub 端有無變動」）。
ALTER TABLE `manual_issues` ADD `github_repo` text;
--> statement-breakpoint
ALTER TABLE `manual_issues` ADD `github_number` integer;
--> statement-breakpoint
ALTER TABLE `manual_issues` ADD `github_state` text;
--> statement-breakpoint
ALTER TABLE `manual_issues` ADD `github_title` text;
--> statement-breakpoint
ALTER TABLE `manual_issues` ADD `github_synced_at` integer;
--> statement-breakpoint
CREATE INDEX `manual_issues_github_idx` ON `manual_issues` (`github_repo`, `github_number`);
--> statement-breakpoint
-- 專案連動：問題的「專案 / Repo」名稱（不分大小寫）→ GitHub owner/name；任何成員可編輯。
CREATE TABLE `eng_github_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL COLLATE NOCASE,
	`github_repo` text NOT NULL,
	`updated_by` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eng_github_links_project_idx` ON `eng_github_links` (`project`);
