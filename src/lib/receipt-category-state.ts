import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { merchantCategoryMapping, receipt, receiptCategory, receiptExtraction } from "@/db/schema";
import { isCategoryId, normalizeMerchant, type CategoryId } from "@/lib/category";
import { validateReceiptExtraction } from "@/lib/receipt-extraction";

export type CategorySource = "merchant_rule" | "jev" | "user" | "unclassified";

export interface ReceiptCategoryState {
  suggestedCategory: CategoryId | null;
  selectedProbability: number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  source: CategorySource;
  needsReview: boolean;
  confirmedCategory: CategoryId | null;
  model: string | null;
  questionVersion: string | null;
  attemptedAt: string | null;
}

type RawCategoryState = typeof receiptCategory.$inferSelect | undefined;

export function toPublicCategoryState(row: RawCategoryState): ReceiptCategoryState {
  let probabilities: Record<string, number> | null = null;
  if (row?.probabilitiesJson) {
    try {
      const parsed: unknown = JSON.parse(row.probabilitiesJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        if (entries.every(([key, value]) => isCategoryId(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
          probabilities = Object.fromEntries(entries) as Record<string, number>;
        }
      }
    } catch { /* Treat corrupt metadata as absent. */ }
  }
  return {
    suggestedCategory: isCategoryId(row?.suggestedCategory) ? row.suggestedCategory : null,
    selectedProbability: validProbability(row?.selectedProbability),
    confidence: validProbability(row?.confidence),
    probabilities,
    source: row?.source === "merchant_rule" || row?.source === "jev" || row?.source === "user" ? row.source : "unclassified",
    needsReview: row?.needsReview ?? true,
    confirmedCategory: isCategoryId(row?.confirmedCategory) ? row.confirmedCategory : null,
    model: row?.model ?? null,
    questionVersion: row?.questionVersion ?? null,
    attemptedAt: row?.attemptedAt?.toISOString() ?? null,
  };
}

function validProbability(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export async function findMerchantCategoryMapping(userId: string, merchant: string | null) {
  if (!merchant) return null;
  const normalizedMerchant = normalizeMerchant(merchant);
  if (!normalizedMerchant) return null;
  const [mapping] = await db.select().from(merchantCategoryMapping).where(and(
    eq(merchantCategoryMapping.userId, userId),
    eq(merchantCategoryMapping.normalizedMerchant, normalizedMerchant),
  )).limit(1);
  return mapping && isCategoryId(mapping.categoryId) ? mapping.categoryId : null;
}

export async function saveCategorySuggestion(input: {
  receiptId: string;
  suggestedCategory: CategoryId | null;
  selectedProbability: number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  source: CategorySource;
  needsReview: boolean;
  model: string | null;
  questionVersion: string | null;
  attemptedAt: Date;
}) {
  const [existing] = await db.select({ confirmedCategory: receiptCategory.confirmedCategory })
    .from(receiptCategory).where(eq(receiptCategory.receiptId, input.receiptId)).limit(1);
  const now = new Date();
  const values = {
    receiptId: input.receiptId,
    suggestedCategory: input.suggestedCategory,
    selectedProbability: input.selectedProbability,
    confidence: input.confidence,
    probabilitiesJson: input.probabilities ? JSON.stringify(input.probabilities) : null,
    source: input.source,
    needsReview: input.needsReview,
    confirmedCategory: existing?.confirmedCategory ?? null,
    model: input.model,
    questionVersion: input.questionVersion,
    attemptedAt: input.attemptedAt,
    updatedAt: now,
  };
  await db.insert(receiptCategory).values(values).onConflictDoUpdate({
    target: receiptCategory.receiptId,
    set: {
      suggestedCategory: values.suggestedCategory,
      selectedProbability: values.selectedProbability,
      confidence: values.confidence,
      probabilitiesJson: values.probabilitiesJson,
      source: sql`case when ${receiptCategory.confirmedCategory} is null then excluded.source else ${receiptCategory.source} end`,
      needsReview: sql`case when ${receiptCategory.confirmedCategory} is null then excluded.needs_review else ${receiptCategory.needsReview} end`,
      model: values.model,
      questionVersion: values.questionVersion,
      attemptedAt: values.attemptedAt,
      updatedAt: now,
      // A later AI pass must never replace user confirmation.
    },
  });
}

export async function confirmReceiptCategory(input: {
  receiptId: string;
  userId: string;
  categoryId: CategoryId;
  merchant: string | null;
}) {
  const now = new Date();
  db.transaction((tx) => {
    const existing = tx.select().from(receiptCategory)
      .where(eq(receiptCategory.receiptId, input.receiptId)).get();
    tx.insert(receiptCategory).values({
      receiptId: input.receiptId,
      suggestedCategory: existing?.suggestedCategory ?? input.categoryId,
      selectedProbability: existing?.selectedProbability ?? null,
      confidence: existing?.confidence ?? null,
      probabilitiesJson: existing?.probabilitiesJson ?? null,
      source: "user",
      needsReview: false,
      confirmedCategory: input.categoryId,
      model: existing?.model ?? null,
      questionVersion: existing?.questionVersion ?? null,
      attemptedAt: existing?.attemptedAt ?? now,
      updatedAt: now,
      confirmedAt: now,
    }).onConflictDoUpdate({
      target: receiptCategory.receiptId,
      set: { confirmedCategory: input.categoryId, source: "user", needsReview: false, confirmedAt: now, updatedAt: now },
    }).run();

    if (input.merchant) {
      const normalizedMerchant = normalizeMerchant(input.merchant);
      if (normalizedMerchant) {
        tx.insert(merchantCategoryMapping).values({
          id: randomUUID(), userId: input.userId, normalizedMerchant,
          categoryId: input.categoryId, createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
          target: [merchantCategoryMapping.userId, merchantCategoryMapping.normalizedMerchant],
          set: { categoryId: input.categoryId, updatedAt: now },
        }).run();
      }
    }
  });
}

export type ConfirmedReceiptCategory = {
  receiptId: string;
  categoryId: CategoryId;
};

/** Issue #10 handoff: only returns a category explicitly confirmed by this owner. */
export async function getConfirmedReceiptCategory(userId: string, receiptId: string): Promise<ConfirmedReceiptCategory | null> {
  const [row] = await db.select({ receiptId: receipt.id, categoryId: receiptCategory.confirmedCategory, extractionStatus: receiptExtraction.status, resultJson: receiptExtraction.resultJson })
    .from(receipt).innerJoin(receiptCategory, eq(receiptCategory.receiptId, receipt.id))
    .innerJoin(receiptExtraction, eq(receiptExtraction.receiptId, receipt.id))
    .where(and(eq(receipt.id, receiptId), eq(receipt.ownerUserId, userId))).limit(1);
  if (!row || !isCategoryId(row.categoryId) || row.extractionStatus !== "succeeded" || !row.resultJson) return null;
  try {
    if (validateReceiptExtraction(JSON.parse(row.resultJson)).documentKind !== "receipt") return null;
  } catch {
    return null;
  }
  return { receiptId: row.receiptId, categoryId: row.categoryId };
}
