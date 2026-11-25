-- 穩定識別碼（uid）：跨資料庫匯出 / 匯入時用來對應同一筆資料（整數 id 在不同 DB 會對不上）。
-- 既有列回填隨機 32 碼 hex；之後任何建立路徑（API、CLI、seed、直接 SQL）由 AFTER INSERT trigger 在 uid 為 NULL 時自動補上。
-- users 以 username 為自然鍵、eng_github_links 以 project 為自然鍵，不加 uid。
ALTER TABLE `projects` ADD `uid` text;
--> statement-breakpoint
UPDATE `projects` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_uid_uq` ON `projects` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `projects_uid_ai` AFTER INSERT ON `projects` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `projects` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `statuses` ADD `uid` text;
--> statement-breakpoint
UPDATE `statuses` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_uid_uq` ON `statuses` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `statuses_uid_ai` AFTER INSERT ON `statuses` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `statuses` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `uid` text;
--> statement-breakpoint
UPDATE `tasks` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_uid_uq` ON `tasks` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `tasks_uid_ai` AFTER INSERT ON `tasks` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `tasks` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `property_defs` ADD `uid` text;
--> statement-breakpoint
UPDATE `property_defs` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `property_defs_uid_uq` ON `property_defs` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `property_defs_uid_ai` AFTER INSERT ON `property_defs` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `property_defs` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `feedback_items` ADD `uid` text;
--> statement-breakpoint
UPDATE `feedback_items` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_items_uid_uq` ON `feedback_items` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `feedback_items_uid_ai` AFTER INSERT ON `feedback_items` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `feedback_items` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `personal_items` ADD `uid` text;
--> statement-breakpoint
UPDATE `personal_items` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_items_uid_uq` ON `personal_items` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `personal_items_uid_ai` AFTER INSERT ON `personal_items` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `personal_items` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `manual_issues` ADD `uid` text;
--> statement-breakpoint
UPDATE `manual_issues` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_issues_uid_uq` ON `manual_issues` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `manual_issues_uid_ai` AFTER INSERT ON `manual_issues` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `manual_issues` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
ALTER TABLE `worktree_records` ADD `uid` text;
--> statement-breakpoint
UPDATE `worktree_records` SET `uid` = lower(hex(randomblob(16))) WHERE `uid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_records_uid_uq` ON `worktree_records` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `worktree_records_uid_ai` AFTER INSERT ON `worktree_records` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `worktree_records` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
