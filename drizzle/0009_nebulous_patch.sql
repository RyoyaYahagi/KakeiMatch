CREATE TABLE `reconciliation_pair_rejection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`statement_transaction_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`statement_transaction_id`) REFERENCES `statement_transaction`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`receipt_id`) REFERENCES `receipt`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`,`user_id`) REFERENCES `reconciliation_run`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_pair_rejection_user_pair_unique` ON `reconciliation_pair_rejection` (`user_id`,`statement_transaction_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `reconciliation_pair_rejection_user_statement_idx` ON `reconciliation_pair_rejection` (`user_id`,`statement_transaction_id`);--> statement-breakpoint
CREATE TABLE `reconciliation_resolution` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`statement_transaction_id` text NOT NULL,
	`run_id` text NOT NULL,
	`resolution` text NOT NULL,
	`source` text NOT NULL,
	`receipt_id` text,
	`category_id` text,
	`actual_account_id` text,
	`imported_id` text,
	`apply_status` text NOT NULL,
	`actual_transaction_id` text,
	`statement_amount_yen` integer NOT NULL,
	`error_code` text,
	`claim_token` text,
	`claim_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`statement_transaction_id`) REFERENCES `statement_transaction`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`,`user_id`) REFERENCES `reconciliation_run`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`receipt_id`) REFERENCES `receipt`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_resolution_imported_id_unique` ON `reconciliation_resolution` (`imported_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_resolution_user_statement_unique` ON `reconciliation_resolution` (`user_id`,`statement_transaction_id`);--> statement-breakpoint
CREATE INDEX `reconciliation_resolution_user_apply_idx` ON `reconciliation_resolution` (`user_id`,`apply_status`);