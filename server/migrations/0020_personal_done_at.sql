-- 自由待辦完成時間：狀態變為 done 時寫入，改回其他狀態時清為 NULL（供個人頁「匯報報告」依完成日統計）
ALTER TABLE `personal_items` ADD `done_at` integer;
--> statement-breakpoint
-- 回填：既有 done 的自由待辦以 updated_at 作為完成時間（無法得知真正完成時刻）
UPDATE `personal_items` SET `done_at` = `updated_at` WHERE `status` = 'done' AND `task_id` IS NULL;
