CREATE TABLE `merchant_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`normalized_merchant` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_alias_user_pair_unique` ON `merchant_alias` (`user_id`,`normalized_merchant`,`normalized_alias`);--> statement-breakpoint
CREATE INDEX `merchant_alias_user_merchant_idx` ON `merchant_alias` (`user_id`,`normalized_merchant`);--> statement-breakpoint
CREATE TABLE `reconciliation_candidate` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`statement_transaction_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`rank` integer NOT NULL,
	`score` real NOT NULL,
	`amount_delta_yen` integer NOT NULL,
	`date_distance_days` integer NOT NULL,
	`merchant_similarity` real NOT NULL,
	`amount_exact` integer NOT NULL,
	`date_close` integer NOT NULL,
	`merchant_similar` integer NOT NULL,
	`reason_codes_json` text NOT NULL,
	FOREIGN KEY (`run_id`,`user_id`) REFERENCES `reconciliation_run`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`statement_transaction_id`) REFERENCES `statement_transaction`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`receipt_id`) REFERENCES `receipt`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_candidate_statement_rank_unique` ON `reconciliation_candidate` (`run_id`,`statement_transaction_id`,`rank`);--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_candidate_pair_unique` ON `reconciliation_candidate` (`run_id`,`statement_transaction_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `reconciliation_candidate_user_run_idx` ON `reconciliation_candidate` (`user_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `reconciliation_receipt_result` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`status` text NOT NULL,
	`statement_transaction_id` text,
	`score` real,
	`reason_codes_json` text NOT NULL,
	FOREIGN KEY (`run_id`,`user_id`) REFERENCES `reconciliation_run`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`receipt_id`) REFERENCES `receipt`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`statement_transaction_id`) REFERENCES `statement_transaction`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_receipt_result_unique` ON `reconciliation_receipt_result` (`run_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `reconciliation_receipt_result_user_run_idx` ON `reconciliation_receipt_result` (`user_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `reconciliation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rule_version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_run_user_id_unique` ON `reconciliation_run` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `reconciliation_run_latest_idx` ON `reconciliation_run` (`user_id`,`status`,`completed_at`);--> statement-breakpoint
CREATE TABLE `reconciliation_statement_result` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`statement_transaction_id` text NOT NULL,
	`status` text NOT NULL,
	`matched_receipt_id` text,
	`score` real,
	`reason_codes_json` text NOT NULL,
	FOREIGN KEY (`run_id`,`user_id`) REFERENCES `reconciliation_run`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`statement_transaction_id`) REFERENCES `statement_transaction`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`matched_receipt_id`) REFERENCES `receipt`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_statement_result_unique` ON `reconciliation_statement_result` (`run_id`,`statement_transaction_id`);--> statement-breakpoint
CREATE INDEX `reconciliation_statement_result_user_run_idx` ON `reconciliation_statement_result` (`user_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_owner_id_unique` ON `receipt` (`owner_user_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `statement_transaction_user_id_unique` ON `statement_transaction` (`user_id`,`id`);