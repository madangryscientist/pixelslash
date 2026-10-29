-- PS-274: relax users.github_id and invites.github_login to nullable, which SQLite does only by a
-- table rebuild. D1 has no PRAGMA foreign_keys, and DROP TABLE users runs its ON DELETE actions even
-- with checks deferred: it would empty sessions, members, user_tokens and detection_flags and null
-- the flakes' authors. So those rows are kept beside the drop and put back after the rename.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__keep_sessions` AS SELECT * FROM `sessions`;--> statement-breakpoint
CREATE TABLE `__keep_members` AS SELECT * FROM `members`;--> statement-breakpoint
CREATE TABLE `__keep_user_tokens` AS SELECT * FROM `user_tokens`;--> statement-breakpoint
CREATE TABLE `__keep_detection_flags` AS SELECT * FROM `detection_flags`;--> statement-breakpoint
CREATE TABLE `__keep_flakes` AS SELECT `id`, `created_by`, `resolved_by` FROM `flakes`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer,
	`google_sub` text,
	`email` text,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "github_id", "google_sub", "email", "login", "name", "avatar_url", "created_at") SELECT "id", "github_id", NULL, NULL, "login", "name", "avatar_url", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
INSERT OR IGNORE INTO `sessions` SELECT * FROM `__keep_sessions`;--> statement-breakpoint
INSERT OR IGNORE INTO `members` SELECT * FROM `__keep_members`;--> statement-breakpoint
INSERT OR IGNORE INTO `user_tokens` SELECT * FROM `__keep_user_tokens`;--> statement-breakpoint
INSERT OR IGNORE INTO `detection_flags` SELECT * FROM `__keep_detection_flags`;--> statement-breakpoint
UPDATE `flakes` SET `created_by` = (SELECT k.`created_by` FROM `__keep_flakes` k WHERE k.`id` = `flakes`.`id`), `resolved_by` = (SELECT k.`resolved_by` FROM `__keep_flakes` k WHERE k.`id` = `flakes`.`id`) WHERE `id` IN (SELECT `id` FROM `__keep_flakes`);--> statement-breakpoint
DROP TABLE `__keep_sessions`;--> statement-breakpoint
DROP TABLE `__keep_members`;--> statement-breakpoint
DROP TABLE `__keep_user_tokens`;--> statement-breakpoint
DROP TABLE `__keep_detection_flags`;--> statement-breakpoint
DROP TABLE `__keep_flakes`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_unique` ON `users` (`login`);--> statement-breakpoint
CREATE TABLE `__new_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`github_login` text,
	`email` text,
	`invited_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_invites`("id", "org_id", "github_login", "email", "invited_by", "created_at") SELECT "id", "org_id", "github_login", NULL, "invited_by", "created_at" FROM `invites`;--> statement-breakpoint
DROP TABLE `invites`;--> statement-breakpoint
ALTER TABLE `__new_invites` RENAME TO `invites`;--> statement-breakpoint
CREATE INDEX `invites_login_idx` ON `invites` (`github_login`);--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_org_id_github_login_unique` ON `invites` (`org_id`,`github_login`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_org_id_email_unique` ON `invites` (`org_id`,`email`);