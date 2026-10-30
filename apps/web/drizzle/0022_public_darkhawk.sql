ALTER TABLE `builds` ADD `ai_summary_queued_at` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `ai_summary_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `ai_queued_at` integer;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `ai_error` text;