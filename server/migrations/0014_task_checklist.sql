-- 任務待辦清單（feat/task-checklist）：每個任務可有多個獨立可勾選的待辦項目。
-- uid 沿用 0005 的做法（匯出 / 匯入以 uid 對應）；任務實際刪除時連動刪除（軟刪除的任務清單保留）。
CREATE TABLE `task_checklist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`task_id` integer NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`text` text NOT NULL,
	`is_done` integer DEFAULT 0 NOT NULL,
	`sort_order` real NOT NULL,
	`done_at` integer,
	`done_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`updated_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `task_checklist_items_text_len` CHECK (length(`text`) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_checklist_items_uid_uq` ON `task_checklist_items` (`uid`);
--> statement-breakpoint
CREATE INDEX `task_checklist_items_task_idx` ON `task_checklist_items` (`task_id`, `sort_order`);
--> statement-breakpoint
CREATE TRIGGER `task_checklist_items_uid_ai` AFTER INSERT ON `task_checklist_items` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `task_checklist_items` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;