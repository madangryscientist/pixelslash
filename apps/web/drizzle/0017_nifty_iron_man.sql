CREATE TABLE `project_models` (
	`project_id` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`api_key` text NOT NULL,
	`auto_pass_noise` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `snapshots` ADD `ai_review` text;