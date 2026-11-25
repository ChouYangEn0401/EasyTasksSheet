-- 描述鎖定（docs/design/task-discussion.md §鎖定）：鎖定後只有具 tasks.lock 權限者可修改描述，
-- 其他成員改在討論區補充。locked_by / locked_at 只在鎖定中有值，解鎖時清除。
ALTER TABLE `tasks` ADD `description_locked` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `locked_by` integer REFERENCES `users`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `locked_at` integer;
