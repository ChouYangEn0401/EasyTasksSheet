-- 任務完成時間：狀態類別轉為 done 時寫入，改回非 done 時清為 NULL（供總覽「本週完成」精確計算）
ALTER TABLE `tasks` ADD `completed_at` integer;
--> statement-breakpoint
-- 回填：既有 done 類別任務以 updated_at 作為完成時間（無法得知真正完成時刻）
UPDATE `tasks` SET `completed_at` = `updated_at`
WHERE `status_id` IN (SELECT `id` FROM `statuses` WHERE `category` = 'done');
