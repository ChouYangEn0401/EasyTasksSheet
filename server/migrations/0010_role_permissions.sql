-- 權限設定（feat/perm-config，docs/permissions.md）：只儲存與預設矩陣不同的「覆寫」。
-- 預設矩陣定義在 server/app/permissions.py；沒有覆寫的格子採預設，之後新增的 capability 不需 migration。
-- root 恆擁有全部權限，不可覆寫（role 只允許 manager / user）。
CREATE TABLE `role_permissions` (
	`role` text NOT NULL CHECK (`role` IN ('manager', 'user')),
	`capability` text NOT NULL,
	`allowed` integer NOT NULL CHECK (`allowed` IN (0, 1)),
	`updated_at` integer NOT NULL,
	`updated_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL,
	PRIMARY KEY (`role`, `capability`)
);
