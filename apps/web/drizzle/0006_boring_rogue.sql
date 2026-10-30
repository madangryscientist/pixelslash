ALTER TABLE `snapshots` ADD `carried_from` text;--> statement-breakpoint
CREATE INDEX `snapshots_carried_idx` ON `snapshots` (`carried_from`);