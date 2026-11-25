-- 帳號是否列入總覽統計（成員卡片 / 近三週處理）。超級管理員通常只負責管理，既有 root 回填為 0。
ALTER TABLE `users` ADD `in_overview` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `in_overview` = 0 WHERE `role` = 'root';
