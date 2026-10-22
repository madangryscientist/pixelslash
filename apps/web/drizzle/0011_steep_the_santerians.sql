ALTER TABLE `projects` ADD `diff_location` text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `measured_by` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `engine_version` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `ci_results` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `diff_error` text;