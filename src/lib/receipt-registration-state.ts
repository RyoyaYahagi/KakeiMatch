import { and, eq, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { actualAccountPreference, receipt, receiptRegistration } from "@/db/schema";
import { isCategoryId, type CategoryId } from "@/lib/category";
import { receiptImportedId, receiptRegistrationInputSchema } from "@/lib/receipt-registration-input";

const CLAIM_LEASE_MS = 2 * 60 * 1000;

export interface ReceiptRegistrationDraft {
  receiptId: string;
  merchant: string;
  purchasedDate: string;
  totalAmountYen: number;
  categoryId: CategoryId;
  actualAccountId: string;
  status: "draft" | "registering" | "registered" | "failed";
  importedId: string;
  actualTransactionId: string | null;
  lastErrorCode: string | null;
  attemptedAt: string | null;
  registeredAt: string | null;
  updatedAt: string;
}

type RegistrationRow = typeof receiptRegistration.$inferSelect;

function toPublicDraft(row: RegistrationRow | undefined): ReceiptRegistrationDraft | null {
  if (!row || !isCategoryId(row.categoryId) || !isStatus(row.status)) return null;
  return {
    receiptId: row.receiptId,
    merchant: row.merchant,
    purchasedDate: row.purchasedDate,
    totalAmountYen: row.totalAmountYen,
    categoryId: row.categoryId,
    actualAccountId: row.actualAccountId,
    status: row.status,
    importedId: row.importedId,
    actualTransactionId: row.actualTransactionId,
    lastErrorCode: row.lastErrorCode,
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isStatus(value: string): value is ReceiptRegistrationDraft["status"] {
  return value === "draft" || value === "registering" || value === "registered" || value === "failed";
}

/** Reads a draft only when the receipt belongs to the authenticated owner. */
export async function getReceiptRegistrationDraft(userId: string, receiptId: string): Promise<ReceiptRegistrationDraft | null> {
  const [row] = await db.select({ registration: receiptRegistration })
    .from(receiptRegistration)
    .innerJoin(receipt, eq(receipt.id, receiptRegistration.receiptId))
    .where(and(eq(receipt.ownerUserId, userId), eq(receipt.id, receiptId)))
    .limit(1);
  return toPublicDraft(row?.registration);
}

export interface SaveReceiptRegistrationDraftInput {
  userId: string;
  receiptId: string;
  merchant: string;
  purchasedDate: string;
  totalAmountYen: number;
  categoryId: CategoryId;
  actualAccountId: string;
}

/** Saves corrected final values. Existing importedId is retained across edits and retries. */
export async function saveReceiptRegistrationDraft(input: SaveReceiptRegistrationDraftInput): Promise<ReceiptRegistrationDraft> {
  validateDraft(input);
  const now = new Date();
  const result = db.transaction((tx) => {
    const [owner] = tx.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.id, input.receiptId), eq(receipt.ownerUserId, input.userId))).limit(1).all();
    if (!owner) throw new Error("receipt_not_found");

    const existing = tx.select().from(receiptRegistration)
      .where(eq(receiptRegistration.receiptId, input.receiptId)).get();
    // Even an expired lease keeps its snapshot immutable: an Actual write may have
    // succeeded before the caller lost its database response.
    if (existing?.status === "registered" || existing?.status === "registering"
      || (existing?.status === "failed" && existing.lastErrorCode === "actual_write_uncertain")) {
      throw new Error("registration_not_editable");
    }

    const values = {
      receiptId: input.receiptId,
      merchant: input.merchant.trim(),
      purchasedDate: input.purchasedDate,
      totalAmountYen: input.totalAmountYen,
      categoryId: input.categoryId,
      actualAccountId: input.actualAccountId,
      status: "draft",
      importedId: existing?.importedId ?? receiptImportedId(input.receiptId),
      actualTransactionId: null,
      lastErrorCode: existing?.lastErrorCode ?? null,
      claimToken: null,
      claimExpiresAt: null,
      attemptedAt: existing?.attemptedAt ?? null,
      registeredAt: null,
      updatedAt: now,
    };
    tx.insert(receiptRegistration).values(values).onConflictDoUpdate({
      target: receiptRegistration.receiptId,
      set: {
        merchant: values.merchant,
        purchasedDate: values.purchasedDate,
        totalAmountYen: values.totalAmountYen,
        categoryId: values.categoryId,
        actualAccountId: values.actualAccountId,
        status: "draft",
        actualTransactionId: null,
        lastErrorCode: existing?.lastErrorCode ?? null,
        claimToken: null,
        claimExpiresAt: null,
        registeredAt: null,
        updatedAt: now,
      },
    }).run();
    return tx.select().from(receiptRegistration).where(eq(receiptRegistration.receiptId, input.receiptId)).get();
  });
  const draft = toPublicDraft(result);
  if (!draft) throw new Error("registration_state_invalid");
  return draft;
}

export type ReceiptRegistrationClaimResult =
  | { status: "claimed"; token: string; importedId: string; merchant: string; purchasedDate: string; totalAmountYen: number; categoryId: CategoryId; actualAccountId: string }
  | { status: "busy" | "registered" | "not_ready" | "not_found" };

/** Claims one owner-scoped draft. An expired claim can be replaced after a process crash. */
export async function claimReceiptRegistration(userId: string, receiptId: string): Promise<ReceiptRegistrationClaimResult> {
  const now = new Date();
  const token = randomUUID();
  return db.transaction((tx) => {
    const [owner] = tx.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.id, receiptId), eq(receipt.ownerUserId, userId))).limit(1).all();
    if (!owner) return { status: "not_found" };
    const row = tx.select().from(receiptRegistration).where(eq(receiptRegistration.receiptId, receiptId)).get();
    if (!row) return { status: "not_ready" };
    if (row.status === "registered") return { status: "registered" };
    if (!isCategoryId(row.categoryId) || (row.status !== "draft" && row.status !== "failed" && !(row.status === "registering" && row.claimExpiresAt && row.claimExpiresAt <= now))) {
      return { status: row.status === "registering" ? "busy" : "not_ready" };
    }
    const claimed = tx.update(receiptRegistration).set({
      status: "registering", claimToken: token,
      claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      attemptedAt: now, updatedAt: now,
    }).where(and(
      eq(receiptRegistration.receiptId, receiptId),
      or(eq(receiptRegistration.status, "draft"), eq(receiptRegistration.status, "failed"), and(eq(receiptRegistration.status, "registering"), lt(receiptRegistration.claimExpiresAt, now))),
    )).returning().get();
    if (!claimed) return { status: "busy" };
    return {
      status: "claimed", token, importedId: claimed.importedId,
      merchant: claimed.merchant, purchasedDate: claimed.purchasedDate,
      totalAmountYen: claimed.totalAmountYen, categoryId: claimed.categoryId as CategoryId,
      actualAccountId: claimed.actualAccountId,
    };
  });
}

export interface ReceiptRegistrationClaim {
  receiptId: string;
  token: string;
}

/** Records a safe error code while preserving the final user-reviewed values. */
export async function markReceiptRegistrationFailed(claim: ReceiptRegistrationClaim, errorCode: string): Promise<boolean> {
  const now = new Date();
  const changed = await db.update(receiptRegistration).set({
    status: "failed", lastErrorCode: errorCode, claimToken: null,
    claimExpiresAt: null, updatedAt: now,
  }).where(and(eq(receiptRegistration.receiptId, claim.receiptId), eq(receiptRegistration.status, "registering"), eq(receiptRegistration.claimToken, claim.token))).returning().get();
  return Boolean(changed);
}

/** Finalizes only the claim that still owns the lease. */
export async function markReceiptRegistrationSucceeded(claim: ReceiptRegistrationClaim, transactionId: string): Promise<boolean> {
  if (!transactionId.trim()) throw new Error("transaction_id_required");
  const now = new Date();
  const changed = await db.update(receiptRegistration).set({
    status: "registered", actualTransactionId: transactionId,
    lastErrorCode: null, claimToken: null, claimExpiresAt: null,
    registeredAt: now, updatedAt: now,
  }).where(and(eq(receiptRegistration.receiptId, claim.receiptId), eq(receiptRegistration.status, "registering"), eq(receiptRegistration.claimToken, claim.token))).returning().get();
  return Boolean(changed);
}

export async function getLastUsedActualAccountId(userId: string): Promise<string | null> {
  const [preference] = await db.select({ actualAccountId: actualAccountPreference.actualAccountId })
    .from(actualAccountPreference).where(eq(actualAccountPreference.userId, userId)).limit(1);
  return preference?.actualAccountId ?? null;
}

export async function rememberLastUsedActualAccount(userId: string, actualAccountId: string): Promise<void> {
  const now = new Date();
  await db.insert(actualAccountPreference).values({ userId, actualAccountId, updatedAt: now }).onConflictDoUpdate({
    target: actualAccountPreference.userId,
    set: { actualAccountId, updatedAt: now },
  });
}

function validateDraft(input: SaveReceiptRegistrationDraftInput): void {
  const parsed = receiptRegistrationInputSchema.safeParse({
    merchant: input.merchant,
    purchasedDate: input.purchasedDate,
    totalAmountYen: input.totalAmountYen,
    actualAccountId: input.actualAccountId,
  });
  if (!parsed.success) {
    if (input.merchant.trim().length === 0 || input.merchant.trim().length > 200) throw new Error("invalid_merchant");
    if (!Number.isSafeInteger(input.totalAmountYen) || input.totalAmountYen <= 0) throw new Error("invalid_amount");
    if (!isRealIsoDate(input.purchasedDate)) throw new Error("invalid_purchased_date");
    if (!input.actualAccountId.trim()) throw new Error("invalid_account");
    throw new Error("invalid_registration_input");
  }
  if (!isCategoryId(input.categoryId)) throw new Error("invalid_category");
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
