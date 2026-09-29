import { foreignKey, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Better Auth's email/password and database-session tables.
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

// Actual Budget credentials are deliberately kept in the server-side mapping table.
export const actualBudgetMapping = sqliteTable("actual_budget_mapping", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  syncId: text("sync_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Receipt metadata is private to its owner; image bytes live behind ReceiptStorage.
export const receipt = sqliteTable("receipt", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("receipt_owner_created_at_idx").on(table.ownerUserId, table.createdAt),
  uniqueIndex("receipt_owner_id_unique").on(table.ownerUserId, table.id),
]);

// Extraction state is separate from receipt metadata so retries never affect stored image bytes.
export const receiptExtraction = sqliteTable("receipt_extraction", {
  receiptId: text("receipt_id").primaryKey().references(() => receipt.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  resultJson: text("result_json"),
  needsReview: integer("needs_review", { mode: "boolean" }),
  lastErrorCode: text("last_error_code"),
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }),
  succeededAt: integer("succeeded_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// User-confirmed merchant rules are isolated by owner and normalized merchant.
export const merchantCategoryMapping = sqliteTable("merchant_category_mapping", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  normalizedMerchant: text("normalized_merchant").notNull(),
  categoryId: text("category_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("merchant_category_mapping_user_merchant_unique").on(table.userId, table.normalizedMerchant)]);

// A suggestion is retained separately from the user's confirmed category.
export const receiptCategory = sqliteTable("receipt_category", {
  receiptId: text("receipt_id").primaryKey().references(() => receipt.id, { onDelete: "cascade" }),
  suggestedCategory: text("suggested_category"),
  selectedProbability: real("selected_probability"),
  confidence: real("confidence"),
  probabilitiesJson: text("probabilities_json"),
  source: text("source").notNull(),
  needsReview: integer("needs_review", { mode: "boolean" }).notNull(),
  confirmedCategory: text("confirmed_category"),
  model: text("model"),
  questionVersion: text("question_version"),
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
});

// Final user-reviewed values and the idempotency claim for Actual registration.
export const receiptRegistration = sqliteTable("receipt_registration", {
  receiptId: text("receipt_id").primaryKey().references(() => receipt.id, { onDelete: "cascade" }),
  merchant: text("merchant").notNull(),
  purchasedDate: text("purchased_date").notNull(),
  totalAmountYen: integer("total_amount_yen").notNull(),
  categoryId: text("category_id").notNull(),
  actualAccountId: text("actual_account_id").notNull(),
  status: text("status").notNull(),
  importedId: text("imported_id").notNull().unique(),
  actualTransactionId: text("actual_transaction_id").unique(),
  lastErrorCode: text("last_error_code"),
  claimToken: text("claim_token"),
  claimExpiresAt: integer("claim_expires_at", { mode: "timestamp_ms" }),
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }),
  registeredAt: integer("registered_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Actual category IDs are specific to each user's Budget.
export const actualCategoryMapping = sqliteTable("actual_category_mapping", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  categoryId: text("category_id").notNull(),
  actualCategoryId: text("actual_category_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("actual_category_mapping_user_category_unique").on(table.userId, table.categoryId),
]);

// Remembers only the last selected Actual account for this user.
export const actualAccountPreference = sqliteTable("actual_account_preference", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  actualAccountId: text("actual_account_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Statement rows are normalized before persistence; only the private raw file keeps provider columns.
export const statementImport = sqliteTable("statement_import", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  fileHash: text("file_hash").notNull(),
  encoding: text("encoding").notNull(),
  headerSignature: text("header_signature").notNull(),
  status: text("status").notNull(),
  totalRows: integer("total_rows").notNull(),
  importedRows: integer("imported_rows").notNull(),
  duplicateRows: integer("duplicate_rows").notNull(),
  excludedRows: integer("excluded_rows").notNull(),
  rejectedRows: integer("rejected_rows").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("statement_import_user_provider_hash_unique").on(table.userId, table.provider, table.fileHash),
  index("statement_import_user_created_idx").on(table.userId, table.createdAt),
]);

export const statementTransaction = sqliteTable("statement_transaction", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => statementImport.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id"),
  kind: text("kind").notNull(),
  usedDate: text("used_date").notNull(),
  usedTime: text("used_time"),
  postedDate: text("posted_date"),
  merchant: text("merchant").notNull(),
  amountYen: integer("amount_yen").notNull(),
  paymentMethod: text("payment_method"),
  sourceFingerprint: text("source_fingerprint").notNull(),
  duplicateOrdinal: integer("duplicate_ordinal").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("statement_transaction_external_unique").on(table.userId, table.provider, table.externalId).where(sql`external_id is not null`),
  uniqueIndex("statement_transaction_fingerprint_ordinal_unique").on(table.userId, table.provider, table.sourceFingerprint, table.duplicateOrdinal).where(sql`external_id is null`),
  uniqueIndex("statement_transaction_user_id_unique").on(table.userId, table.id),
  index("statement_transaction_user_date_idx").on(table.userId, table.usedDate),
]);

// Only explicit user confirmation may create a merchant alias. Reconciliation never learns aliases automatically.
export const merchantAlias = sqliteTable("merchant_alias", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  normalizedMerchant: text("normalized_merchant").notNull(),
  normalizedAlias: text("normalized_alias").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("merchant_alias_user_pair_unique").on(table.userId, table.normalizedMerchant, table.normalizedAlias),
  index("merchant_alias_user_merchant_idx").on(table.userId, table.normalizedMerchant),
]);

export const reconciliationRun = sqliteTable("reconciliation_run", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  ruleVersion: text("rule_version").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("reconciliation_run_user_id_unique").on(table.userId, table.id),
  index("reconciliation_run_latest_idx").on(table.userId, table.status, table.completedAt),
]);

export const reconciliationStatementResult = sqliteTable("reconciliation_statement_result", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  statementTransactionId: text("statement_transaction_id").notNull(),
  status: text("status").notNull(),
  matchedReceiptId: text("matched_receipt_id"),
  score: real("score"),
  reasonCodesJson: text("reason_codes_json").notNull(),
}, (table) => [
  foreignKey({ columns: [table.runId, table.userId], foreignColumns: [reconciliationRun.id, reconciliationRun.userId] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.statementTransactionId], foreignColumns: [statementTransaction.userId, statementTransaction.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.matchedReceiptId], foreignColumns: [receipt.ownerUserId, receipt.id] }).onDelete("cascade"),
  uniqueIndex("reconciliation_statement_result_unique").on(table.runId, table.statementTransactionId),
  uniqueIndex("reconciliation_statement_result_match_unique").on(table.runId, table.matchedReceiptId).where(sql`matched_receipt_id is not null`),
  index("reconciliation_statement_result_user_run_idx").on(table.userId, table.runId),
]);

export const reconciliationReceiptResult = sqliteTable("reconciliation_receipt_result", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  receiptId: text("receipt_id").notNull(),
  status: text("status").notNull(),
  statementTransactionId: text("statement_transaction_id"),
  score: real("score"),
  reasonCodesJson: text("reason_codes_json").notNull(),
}, (table) => [
  foreignKey({ columns: [table.runId, table.userId], foreignColumns: [reconciliationRun.id, reconciliationRun.userId] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.receiptId], foreignColumns: [receipt.ownerUserId, receipt.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.statementTransactionId], foreignColumns: [statementTransaction.userId, statementTransaction.id] }).onDelete("cascade"),
  uniqueIndex("reconciliation_receipt_result_unique").on(table.runId, table.receiptId),
  uniqueIndex("reconciliation_receipt_result_match_unique").on(table.runId, table.statementTransactionId).where(sql`statement_transaction_id is not null`),
  index("reconciliation_receipt_result_user_run_idx").on(table.userId, table.runId),
]);

export const reconciliationCandidate = sqliteTable("reconciliation_candidate", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  statementTransactionId: text("statement_transaction_id").notNull(),
  receiptId: text("receipt_id").notNull(),
  rank: integer("rank").notNull(),
  score: real("score").notNull(),
  amountDeltaYen: integer("amount_delta_yen").notNull(),
  dateDistanceDays: integer("date_distance_days").notNull(),
  merchantSimilarity: real("merchant_similarity").notNull(),
  amountExact: integer("amount_exact", { mode: "boolean" }).notNull(),
  dateClose: integer("date_close", { mode: "boolean" }).notNull(),
  merchantSimilar: integer("merchant_similar", { mode: "boolean" }).notNull(),
  reasonCodesJson: text("reason_codes_json").notNull(),
}, (table) => [
  foreignKey({ columns: [table.runId, table.userId], foreignColumns: [reconciliationRun.id, reconciliationRun.userId] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.statementTransactionId], foreignColumns: [statementTransaction.userId, statementTransaction.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.receiptId], foreignColumns: [receipt.ownerUserId, receipt.id] }).onDelete("cascade"),
  uniqueIndex("reconciliation_candidate_statement_rank_unique").on(table.runId, table.statementTransactionId, table.rank),
  uniqueIndex("reconciliation_candidate_pair_unique").on(table.runId, table.statementTransactionId, table.receiptId),
  index("reconciliation_candidate_user_run_idx").on(table.userId, table.runId),
]);

export const authSchema = { user, session, account, verification, actualBudgetMapping, receipt, receiptExtraction, merchantCategoryMapping, receiptCategory, receiptRegistration, actualCategoryMapping, actualAccountPreference, statementImport, statementTransaction, merchantAlias, reconciliationRun, reconciliationCandidate, reconciliationStatementResult, reconciliationReceiptResult };
