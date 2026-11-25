-- 在線感知的「最後上線」持久化（feat/presence）：伺服器重啟後即時 presence 清空，
-- 「最後上線多久前、最後看的是哪個頁面」由此表補上。獨立成表，不動 users（避免與帳號相關功能衝突）。
-- last_view 為頁面名稱（如「甘特圖」）；使用者選擇「隱藏我的動態」時寫入 NULL。
CREATE TABLE `user_presence` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_view` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
