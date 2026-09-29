CREATE TABLE `merchant_category_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`normalized_merchant` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_category_mapping_user_merchant_unique` ON `merchant_category_mapping` (`user_id`,`normalized_merchant`);--> statement-breakpoint
CREATE TABLE `receipt_category` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`suggested_category` text,
	`selected_probability` real,
	`confidence` real,
	`probabilities_json` text,
	`source` text NOT NULL,
	`needs_review` integer NOT NULL,
	`confirmed_category` text,
	`model` text,
	`question_version` text,
	`attempted_at` integer,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE cascade
);
