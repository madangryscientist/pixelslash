ALTER TABLE `snapshots` ADD `main_baseline_key` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `main_diff_key` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `main_diff_status` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `main_diff_result` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `change_note` text;