CREATE TABLE `receipt_extraction` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`result_json` text,
	`needs_review` integer,
	`last_error_code` text,
	`attempted_at` integer,
	`succeeded_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE cascade
);
