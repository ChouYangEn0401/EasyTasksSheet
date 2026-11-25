-- 稽核紀錄（docs/design/audit-log.md）：與 changes（即時同步用、30 天）分開，保存前後值供回溯與還原。
-- 不設外鍵：成員、狀態等被刪除或停用後，紀錄仍以快照（actor_name、entity_label）完整可讀。
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor_id` integer,
	`actor_name` text,
	`actor_username` text,
	`source` text DEFAULT 'web' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`entity_uid` text,
	`entity_label` text,
	`task_id` integer,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`revertable` integer DEFAULT 0 NOT NULL,
	`note` text,
	`reverted_by` integer,
	`reverted_at` integer,
	`revert_of` integer,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`, `entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_task_idx` ON `audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `audit_log_revert_of_idx` ON `audit_log` (`revert_of`);
