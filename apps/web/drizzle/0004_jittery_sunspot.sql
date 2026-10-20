ALTER TABLE `builds` ADD `error` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `diff_result` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `rebaseline_needed` integer DEFAULT false NOT NULL;