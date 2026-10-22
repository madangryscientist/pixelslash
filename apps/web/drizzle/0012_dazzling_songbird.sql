CREATE TABLE `flakes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`browser` text NOT NULL,
	`viewport` text NOT NULL,
	`theme` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution_note` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `flakes_project_idx` ON `flakes` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `flakes_project_id_name_platform_browser_viewport_theme_unique` ON `flakes` (`project_id`,`name`,`platform`,`browser`,`viewport`,`theme`);--> statement-breakpoint
ALTER TABLE `snapshots` ADD `flaky_policy` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `flake_id` text;