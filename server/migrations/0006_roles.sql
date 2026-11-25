-- 三層角色（docs/permissions.md）：root > manager > user。既有 admin → root、member → user。
-- users.role 沒有 CHECK 約束，不需重建資料表（重建會觸發外鍵 ON DELETE SET NULL，風險高）；
-- 改以 trigger 限制可用值，並把舊值（含欄位預設 'member'）在寫入時轉成新值。
UPDATE `users` SET `role` = 'root' WHERE `role` = 'admin';
--> statement-breakpoint
UPDATE `users` SET `role` = 'user' WHERE `role` NOT IN ('root', 'manager');
--> statement-breakpoint
CREATE TRIGGER `users_role_bi` BEFORE INSERT ON `users`
WHEN NEW.`role` NOT IN ('root', 'manager', 'user', 'admin', 'member')
BEGIN SELECT RAISE(ABORT, 'invalid users.role'); END;
--> statement-breakpoint
CREATE TRIGGER `users_role_ai` AFTER INSERT ON `users` WHEN NEW.`role` IN ('admin', 'member')
BEGIN UPDATE `users` SET `role` = CASE NEW.`role` WHEN 'admin' THEN 'root' ELSE 'user' END WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
CREATE TRIGGER `users_role_bu` BEFORE UPDATE OF `role` ON `users`
WHEN NEW.`role` NOT IN ('root', 'manager', 'user')
BEGIN SELECT RAISE(ABORT, 'invalid users.role'); END;
