CREATE TABLE `actual_budget_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sync_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actual_budget_mapping_user_id_unique` ON `actual_budget_mapping` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `actual_budget_mapping_sync_id_unique` ON `actual_budget_mapping` (`sync_id`);