CREATE TABLE `statement_import` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`storage_key` text NOT NULL,
	`file_hash` text NOT NULL,
	`encoding` text NOT NULL,
	`header_signature` text NOT NULL,
	`status` text NOT NULL,
	`total_rows` integer NOT NULL,
	`imported_rows` integer NOT NULL,
	`duplicate_rows` integer NOT NULL,
	`excluded_rows` integer NOT NULL,
	`rejected_rows` integer NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_import_storage_key_unique` ON `statement_import` (`storage_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `statement_import_user_provider_hash_unique` ON `statement_import` (`user_id`,`provider`,`file_hash`);--> statement-breakpoint
CREATE INDEX `statement_import_user_created_idx` ON `statement_import` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `statement_transaction` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`kind` text NOT NULL,
	`used_date` text NOT NULL,
	`used_time` text,
	`posted_date` text,
	`merchant` text NOT NULL,
	`amount_yen` integer NOT NULL,
	`payment_method` text,
	`source_fingerprint` text NOT NULL,
	`duplicate_ordinal` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `statement_import`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_transaction_external_unique` ON `statement_transaction` (`user_id`,`provider`,`external_id`) WHERE external_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `statement_transaction_fingerprint_ordinal_unique` ON `statement_transaction` (`user_id`,`provider`,`source_fingerprint`,`duplicate_ordinal`) WHERE external_id is null;--> statement-breakpoint
CREATE INDEX `statement_transaction_user_date_idx` ON `statement_transaction` (`user_id`,`used_date`);
