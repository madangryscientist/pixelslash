ALTER TABLE `projects` ADD `parent_project_id` text REFERENCES projects(id) ON DELETE cascade;--> statement-breakpoint
DROP INDEX `projects_org_id_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_parent_name_unique` ON `projects` (`org_id`,coalesce(`parent_project_id`, ''),`name`);
