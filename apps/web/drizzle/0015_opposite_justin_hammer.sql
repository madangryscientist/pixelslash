CREATE TABLE `diff_override_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT '' NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`viewport` text DEFAULT '' NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`before` text,
	`after` text,
	`user_id` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `diff_override_changes_project_idx` ON `diff_override_changes` (`project_id`,`at`);--> statement-breakpoint
CREATE TABLE `diff_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT '' NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`viewport` text DEFAULT '' NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`options` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diff_overrides_project_id_name_platform_browser_viewport_theme_unique` ON `diff_overrides` (`project_id`,`name`,`platform`,`browser`,`viewport`,`theme`);--> statement-breakpoint
ALTER TABLE `snapshots` ADD `resolved_diff` text;