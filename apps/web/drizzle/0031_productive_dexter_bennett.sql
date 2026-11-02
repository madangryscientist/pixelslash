CREATE TABLE `pr_comments` (
	`project_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `pr_number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `github_comment` integer DEFAULT true NOT NULL;