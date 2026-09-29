CREATE TABLE `actual_account_preference` (
	`user_id` text PRIMARY KEY NOT NULL,
	`actual_account_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `actual_category_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category_id` text NOT NULL,
	`actual_category_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actual_category_mapping_user_category_unique` ON `actual_category_mapping` (`user_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `receipt_registration` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`merchant` text NOT NULL,
	`purchased_date` text NOT NULL,
	`total_amount_yen` integer NOT NULL,
	`category_id` text NOT NULL,
	`actual_account_id` text NOT NULL,
	`status` text NOT NULL,
	`imported_id` text NOT NULL,
	`actual_transaction_id` text,
	`last_error_code` text,
	`claim_token` text,
	`claim_expires_at` integer,
	`attempted_at` integer,
	`registered_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_registration_imported_id_unique` ON `receipt_registration` (`imported_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_registration_actual_transaction_id_unique` ON `receipt_registration` (`actual_transaction_id`);
