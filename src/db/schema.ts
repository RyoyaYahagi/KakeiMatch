import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
}, (table) => [index("receipt_owner_created_at_idx").on(table.ownerUserId, table.createdAt)]);

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

export const authSchema = { user, session, account, verification, actualBudgetMapping, receipt, receiptExtraction, merchantCategoryMapping, receiptCategory };
