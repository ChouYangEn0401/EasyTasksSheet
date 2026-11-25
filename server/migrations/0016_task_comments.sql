-- 任務討論區（docs/design/task-discussion.md）：留言與討論串（只支援兩層：根訊息 + 回覆）。
-- parent_id NULL = 討論串的根訊息；非 NULL = 該串內的回覆（一律指向根訊息，API 驗證）。
-- reply_to_id：回覆某則回覆時用於顯示「回覆 @某人」。軟刪除（deleted_at）保留討論串結構。
-- mentions：被提及的 user id 陣列（JSON），由後端解析 @帳號 並驗證存在。
-- uid 作法同 0005：AFTER INSERT trigger 在 uid 為 NULL 時自動補上（匯出 / 匯入對應用）。
CREATE TABLE `task_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text,
	`task_id` integer NOT NULL,
	`parent_id` integer,
	`reply_to_id` integer,
	`author_id` integer,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by` integer,
	`thread_resolved_at` integer,
	`thread_resolved_by` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `task_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_to_id`) REFERENCES `task_comments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_comments_uid_uq` ON `task_comments` (`uid`);
--> statement-breakpoint
CREATE INDEX `task_comments_task_created_idx` ON `task_comments` (`task_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `task_comments_parent_idx` ON `task_comments` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `task_comments_author_created_idx` ON `task_comments` (`author_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `task_comments_uid_ai` AFTER INSERT ON `task_comments` WHEN NEW.`uid` IS NULL
BEGIN UPDATE `task_comments` SET `uid` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
-- 未讀計算：每位使用者在每個任務已讀到的最後一則留言
CREATE TABLE `task_comment_reads` (
	`user_id` integer NOT NULL,
	`task_id` integer NOT NULL,
	`last_read_comment_id` integer,
	`last_read_at` integer NOT NULL,
	PRIMARY KEY (`user_id`, `task_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
