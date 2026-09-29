import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt, receiptExtraction } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function notFound() {
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** Reads only extraction data attached to a receipt owned by the session user. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;

  try {
    const [ownedReceipt] = await db.select({ id: receipt.id })
      .from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id)))
      .limit(1);
    if (!ownedReceipt) return notFound();

    const [extraction] = await db.select().from(receiptExtraction)
      .where(eq(receiptExtraction.receiptId, id)).limit(1);
    return privateJson({
      status: extraction?.status ?? "not_started",
      model: extraction?.model ?? null,
      promptVersion: extraction?.promptVersion ?? null,
      result: extraction?.resultJson ? JSON.parse(extraction.resultJson) : null,
      needsReview: extraction?.needsReview ?? null,
      lastErrorCode: extraction?.lastErrorCode ?? null,
      attemptedAt: extraction?.attemptedAt?.toISOString() ?? null,
      succeededAt: extraction?.succeededAt?.toISOString() ?? null,
    });
  } catch {
    return privateJson({ error: "読み取り結果を取得できませんでした。" }, 500);
  }
}
