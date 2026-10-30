CREATE TABLE `detection_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`rect` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `detection_flags_project_idx` ON `detection_flags` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `detection_flags_snapshot_id_created_by_unique` ON `detection_flags` (`snapshot_id`,`created_by`);