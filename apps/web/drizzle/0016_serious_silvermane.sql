CREATE TABLE `ignore_boxes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT '' NOT NULL,
	`browser` text DEFAULT '' NOT NULL,
	`viewport` text DEFAULT '' NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`cleared_by` text,
	`cleared_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cleared_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ignore_boxes_project_idx` ON `ignore_boxes` (`project_id`,`name`);