CREATE TABLE `receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_storage_key_unique` ON `receipt` (`storage_key`);--> statement-breakpoint
CREATE INDEX `receipt_owner_created_at_idx` ON `receipt` (`owner_user_id`,`created_at`);