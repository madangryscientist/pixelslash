ALTER TABLE `builds` ADD `finished_at` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `queue_ms` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `diff_ms` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `explain_ms` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `summary_ms` integer;--> statement-breakpoint
ALTER TABLE `builds` ADD `rerun` integer DEFAULT false NOT NULL;