import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt, receiptCategory, receiptExtraction } from "@/db/schema";
import { classify } from "@/lib/jev-category-classifier";
import { validateReceiptExtraction } from "@/lib/receipt-extraction";
import { findMerchantCategoryMapping, saveCategorySuggestion, toPublicCategoryState } from "@/lib/receipt-category-state";
import { getCurrentUser } from "@/lib/current-user";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function notFound() { return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } }); }

/** Classifies only the validated extraction stored for the session owner's receipt. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;

  try {
    const [owned] = await db.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id))).limit(1);
    if (!owned) return notFound();

    const [existingState] = await db.select().from(receiptCategory).where(eq(receiptCategory.receiptId, id)).limit(1);
    if (existingState?.confirmedCategory) return privateJson(toPublicCategoryState(existingState));

    const [extractionRow] = await db.select().from(receiptExtraction)
      .where(eq(receiptExtraction.receiptId, id)).limit(1);
    if (!extractionRow || extractionRow.status !== "succeeded" || !extractionRow.resultJson) {
      return privateJson(toPublicCategoryState(existingState));
    }

    let extraction;
    try { extraction = validateReceiptExtraction(JSON.parse(extractionRow.resultJson)); }
    catch { return privateJson(toPublicCategoryState(existingState)); }

    const attemptedAt = new Date();
    if (extraction.documentKind !== "receipt") {
      await saveCategorySuggestion({
        receiptId: id, suggestedCategory: null, selectedProbability: null, confidence: null,
        probabilities: null, source: "unclassified", needsReview: true, model: null,
        questionVersion: null, attemptedAt,
      });
      const [saved] = await db.select().from(receiptCategory).where(eq(receiptCategory.receiptId, id)).limit(1);
      return privateJson(toPublicCategoryState(saved));
    }

    const mapped = await findMerchantCategoryMapping(owner.id, extraction.merchant);
    if (mapped) {
      await saveCategorySuggestion({
        receiptId: id, suggestedCategory: mapped, selectedProbability: null, confidence: null,
        probabilities: null, source: "merchant_rule", needsReview: false, model: null,
        questionVersion: null, attemptedAt,
      });
    } else {
      let result;
      try {
        result = await classify({
          merchant: extraction.merchant,
          totalAmountYen: extraction.totalAmountYen,
          items: extraction.items,
        });
      } catch {
        result = {
          category: null, selectedProbability: null, confidence: null, probabilities: null,
          needsReview: true, source: "unclassified" as const, model: null, questionVersion: null,
        };
      }
      await saveCategorySuggestion({
        receiptId: id,
        suggestedCategory: result.category,
        selectedProbability: result.selectedProbability,
        confidence: result.confidence,
        probabilities: result.probabilities,
        source: result.source,
        needsReview: result.needsReview,
        model: result.model,
        questionVersion: result.questionVersion,
        attemptedAt,
      });
    }
    const [saved] = await db.select().from(receiptCategory).where(eq(receiptCategory.receiptId, id)).limit(1);
    return privateJson(toPublicCategoryState(saved));
  } catch {
    // Provider and persistence diagnostics stay server-side. Provider failures are represented as unclassified.
    return privateJson({ error: "カテゴリを提案できませんでした。" }, 500);
  }
}
