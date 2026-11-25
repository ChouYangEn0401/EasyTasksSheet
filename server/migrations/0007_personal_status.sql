-- 自由待辦的小狀態與細節：status（todo 待處理 / doing 進行中 / deferred 延後 / cancelled 取消 / done 完成）、due_date、detail
-- status 與 is_done 一致：done <-> is_done = 1（由後端維護）；note 沿用為「備註」，detail 為 inspector 的長文細節
ALTER TABLE `personal_items` ADD `status` text DEFAULT 'todo' NOT NULL;
--> statement-breakpoint
ALTER TABLE `personal_items` ADD `due_date` text;
--> statement-breakpoint
ALTER TABLE `personal_items` ADD `detail` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `personal_items` SET `status` = 'done' WHERE `is_done` = 1;
