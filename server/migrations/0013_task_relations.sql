-- 任務關聯（feat/task-relations，docs/design/task-list.md §13）。
-- type 目前只有 related（對稱關係）；欄位保留以便日後擴充（如 blocks）。
-- related 寫入時正規化：task_a_id 為較小的 id（CHECK 保證 a < b，同時禁止自己關聯自己）。
-- 任務為軟刪除：關聯保留；清單 / 計數由 API 決定是否顯示已刪除的對方任務。
CREATE TABLE `task_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`task_a_id` integer NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`task_b_id` integer NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	`type` text DEFAULT 'related' NOT NULL CHECK (`type` IN ('related')),
	`created_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`task_a_id` < `task_b_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_relations_uid_uq` ON `task_relations` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_relations_pair_uq` ON `task_relations` (`task_a_id`, `task_b_id`, `type`);
--> statement-breakpoint
CREATE INDEX `task_relations_b_idx` ON `task_relations` (`task_b_id`);
--> statement-breakpoint
CREATE TRIGGER `task_relations_uid_ai` AFTER INSERT ON `task_relations` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `task_relations` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
