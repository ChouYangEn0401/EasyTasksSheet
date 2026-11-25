-- 附件（通用：entity_type + entity_id；目前用於工程問題 manual_issue）與連結預覽（網頁 metadata）。
-- 檔案本體存於 ATTACHMENTS_DIR，檔名 stored_name 為隨機 32 碼 hex（不使用使用者提供的檔名）。
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`original_name` text NOT NULL,
	`stored_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_uid_uq` ON `attachments` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_stored_uq` ON `attachments` (`stored_name`);
--> statement-breakpoint
CREATE INDEX `attachments_entity_idx` ON `attachments` (`entity_type`, `entity_id`);
--> statement-breakpoint
CREATE TRIGGER `attachments_uid_ai` AFTER INSERT ON `attachments` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `attachments` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
CREATE TABLE `link_previews` (
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`description` text,
	`image_url` text,
	`favicon_url` text,
	`site_name` text,
	`summary` text,
	`content_type` text,
	`error` text,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY (`entity_type`, `entity_id`)
);
--> statement-breakpoint
-- 問題被刪除（API、匯入取代模式、直接 SQL）時一併刪除附件與預覽的資料列；檔案由 API 刪除或孤兒清理處理
CREATE TRIGGER `manual_issues_attachments_ad` AFTER DELETE ON `manual_issues`
BEGIN
	DELETE FROM `attachments` WHERE `entity_type` = 'manual_issue' AND `entity_id` = OLD.`id`;
	DELETE FROM `link_previews` WHERE `entity_type` = 'manual_issue' AND `entity_id` = OLD.`id`;
END;
