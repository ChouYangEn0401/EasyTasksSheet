-- 多台電腦同步（feat/sync-push，docs/sync.md）：本機 → 中央增量上傳。
-- sync_sources：同步來源（每台電腦一組金鑰；DB 只存 SHA-256 雜湊，金鑰本體只在建立 / 重新產生時顯示一次）
CREATE TABLE `sync_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text DEFAULT '' NOT NULL,
	`auto_create_users` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_push_at` integer,
	`last_push_summary` text,
	`last_backup_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_sources_uid_uq` ON `sync_sources` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_sources_token_uq` ON `sync_sources` (`token_hash`);
--> statement-breakpoint
-- sync_conflicts：兩邊都改過、更新時間差距在門檻內的資料，待 manager 決定
CREATE TABLE `sync_conflicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer REFERENCES `sync_sources`(`id`) ON DELETE SET NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`entity_uid` text NOT NULL,
	`local_json` text NOT NULL,
	`incoming_json` text NOT NULL,
	`local_updated_at` integer,
	`incoming_updated_at` integer,
	`diff_fields` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending', 'resolved')),
	`resolution` text CHECK (`resolution` IS NULL OR `resolution` IN ('keep_local', 'use_incoming', 'merged')),
	`merged_json` text,
	`resolved_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_conflicts_status_idx` ON `sync_conflicts` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `sync_conflicts_entity_idx` ON `sync_conflicts` (`source_id`, `category`, `entity_uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_conflicts_pending_uq` ON `sync_conflicts` (`source_id`, `category`, `entity_uid`) WHERE `status` = 'pending';
--> statement-breakpoint
-- sync_uid_aliases：來源的 uid ↔ 中央 uid（狀態 / 專案以名稱對應到中央既有資料時記錄，之後的增量上傳沿用）
CREATE TABLE `sync_uid_aliases` (
	`source_id` integer NOT NULL REFERENCES `sync_sources`(`id`) ON DELETE CASCADE,
	`category` text NOT NULL,
	`source_uid` text NOT NULL,
	`central_uid` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`source_id`, `category`, `source_uid`)
);
