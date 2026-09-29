import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt, receiptExtraction } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { receiptStorage } from "@/lib/receipt-storage";
import {
  deriveNeedsReview,
  RECEIPT_EXTRACTION_PROMPT_VERSION,
  validateReceiptExtraction,
  type ReceiptExtractionResult,
} from "@/lib/receipt-extraction";
import { DEFAULT_GEMINI_MODEL, geminiReceiptExtractor } from "@/lib/gemini-receipt-extractor";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function notFound() {
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const allowed = new Set(["not_configured", "timeout", "rate_limited", "provider_unavailable", "invalid_response"]);
    if (allowed.has(error.code)) return error.code;
  }
  return "provider_unavailable";
}

async function readPublicState(id: string) {
  const [row] = await db.select().from(receiptExtraction).where(eq(receiptExtraction.receiptId, id)).limit(1);
  return {
    status: row?.status ?? "failed",
    model: row?.model ?? DEFAULT_GEMINI_MODEL,
    promptVersion: row?.promptVersion ?? RECEIPT_EXTRACTION_PROMPT_VERSION,
    result: row?.resultJson ? JSON.parse(row.resultJson) as ReceiptExtractionResult : null,
    needsReview: row?.needsReview ?? null,
    lastErrorCode: row?.lastErrorCode ?? "provider_unavailable",
    attemptedAt: row?.attemptedAt?.toISOString() ?? null,
    succeededAt: row?.succeededAt?.toISOString() ?? null,
  };
}

/** Analyze the session owner's saved receipt. The request body is intentionally unused. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;

  let metadata: { storageKey: string; contentType: string } | undefined;
  try {
    [metadata] = await db.select({ storageKey: receipt.storageKey, contentType: receipt.contentType })
      .from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id)))
      .limit(1);
  } catch {
    return privateJson({ error: "レシートを読み取れませんでした。画像は保存されています。もう一度お試しください。" }, 500);
  }
  if (!metadata) return notFound();

  const attemptedAt = new Date();
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  let stage: "storage" | "database" = "storage";
  try {
    // This order is intentional: authorization-scoped metadata, then storage, then provider.
    const imageBytes = await receiptStorage.get(metadata.storageKey);
    if (!imageBytes) throw new Error("missing stored image");
    stage = "database";
    await db.insert(receiptExtraction).values({
      receiptId: id,
      status: "processing",
      model,
      promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION,
      lastErrorCode: null,
      attemptedAt,
      updatedAt: attemptedAt,
    }).onConflictDoUpdate({
      target: receiptExtraction.receiptId,
      set: {
        status: "processing",
        lastErrorCode: null,
        attemptedAt,
        updatedAt: attemptedAt,
      },
    });

    let result: ReceiptExtractionResult;
    try {
      const candidate = await geminiReceiptExtractor.extract({
        imageBytes,
        contentType: metadata.contentType as "image/jpeg" | "image/png" | "image/webp",
      });
      result = validateReceiptExtraction(candidate);
    } catch (error) {
      const code = errorCode(error);
      await db.insert(receiptExtraction).values({
        receiptId: id,
        status: "failed",
        model,
        promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION,
        lastErrorCode: code,
        attemptedAt,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: receiptExtraction.receiptId,
        // Keep model/promptVersion tied to the last successful result on retries.
        set: { status: "failed", lastErrorCode: code, attemptedAt, updatedAt: new Date() },
      });
      return privateJson({
        ...await readPublicState(id),
        status: "failed",
        lastErrorCode: code,
      }, 502);
    }

    const succeededAt = new Date();
    const needsReview = deriveNeedsReview(result);
    await db.insert(receiptExtraction).values({
      receiptId: id,
      status: "succeeded",
      model,
      promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION,
      resultJson: JSON.stringify(result),
      needsReview,
      lastErrorCode: null,
      attemptedAt,
      succeededAt,
      updatedAt: succeededAt,
    }).onConflictDoUpdate({
      target: receiptExtraction.receiptId,
      set: {
        status: "succeeded",
        model,
        promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION,
        resultJson: JSON.stringify(result),
        needsReview,
        lastErrorCode: null,
        attemptedAt,
        succeededAt,
        updatedAt: succeededAt,
      },
    });
    return privateJson({ status: "succeeded", model, promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION, result, needsReview, lastErrorCode: null, attemptedAt: attemptedAt.toISOString(), succeededAt: succeededAt.toISOString() });
  } catch {
    // Keep the original receipt and any prior successful extraction intact on infrastructure errors.
    try {
      const code = stage === "storage" ? "receipt_image_unavailable" : "internal_error";
      await db.insert(receiptExtraction).values({
        receiptId: id, status: "failed", model, promptVersion: RECEIPT_EXTRACTION_PROMPT_VERSION,
        lastErrorCode: code, attemptedAt, updatedAt: new Date(),
      }).onConflictDoUpdate({ target: receiptExtraction.receiptId, set: { status: "failed", lastErrorCode: code, attemptedAt, updatedAt: new Date() } });
    } catch { /* Do not expose database or provider errors to the browser. */ }
    return privateJson({ error: "レシートを読み取れませんでした。画像は保存されています。もう一度お試しください。" }, 502);
  }
}
