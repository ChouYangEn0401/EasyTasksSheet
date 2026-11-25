-- 任務依賴（feat/delay-link，docs/design/delay-link.md）：blocker（前置任務，需先完成）→ blocked（等待中的任務）。
-- 目前只有 finish_to_start：前置任務完成後（再等 lag_days 天）才能開始。
-- 循環由 API 建立前檢查（DFS），資料庫只擋「自己擋自己」與重複。
-- uid 沿用 0005 的作法：AFTER INSERT trigger 在 uid 為 NULL 時補上（匯出 / 匯入對應用）。
CREATE TABLE `task_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`blocker_task_id` integer NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`blocked_task_id` integer NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`type` text DEFAULT 'finish_to_start' NOT NULL CHECK (`type` IN ('finish_to_start')),
	`lag_days` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`blocker_task_id` <> `blocked_task_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_pair_uq` ON `task_dependencies` (`blocker_task_id`, `blocked_task_id`);
--> statement-breakpoint
CREATE INDEX `task_dependencies_blocked_idx` ON `task_dependencies` (`blocked_task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_uid_uq` ON `task_dependencies` (`uid`);
--> statement-breakpoint
CREATE TRIGGER `task_dependencies_uid_ai` AFTER INSERT ON `task_dependencies` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `task_dependencies` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
