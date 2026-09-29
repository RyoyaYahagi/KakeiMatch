import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { receipt, receiptCategory, receiptExtraction } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { isCategoryId } from "@/lib/category";
import { confirmReceiptCategory, toPublicCategoryState } from "@/lib/receipt-category-state";
import { validateReceiptExtraction } from "@/lib/receipt-extraction";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function notFound() { return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } }); }

const confirmationSchema = z.object({ categoryId: z.unknown().refine(isCategoryId) }).strict();

/** Returns category state only when the receipt belongs to the authenticated user. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;
  try {
    const [owned] = await db.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id))).limit(1);
    if (!owned) return notFound();
    const [state] = await db.select().from(receiptCategory).where(eq(receiptCategory.receiptId, id)).limit(1);
    return privateJson(toPublicCategoryState(state));
  } catch {
    return privateJson({ error: "カテゴリを取得できませんでした。" }, 500);
  }
}

/** Confirms a category and learns a per-user exact merchant mapping from this explicit action. */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ error: "ログインしてください。" }, 401);
  const { id } = await context.params;

  let parsedBody: z.infer<typeof confirmationSchema>;
  try {
    const result = confirmationSchema.safeParse(await request.json());
    if (!result.success) return privateJson({ error: "カテゴリを選択してください。" }, 400);
    parsedBody = result.data;
  } catch {
    return privateJson({ error: "カテゴリを選択してください。" }, 400);
  }

  try {
    const [owned] = await db.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id))).limit(1);
    if (!owned) return notFound();

    const [extractionRow] = await db.select().from(receiptExtraction)
      .where(eq(receiptExtraction.receiptId, id)).limit(1);
    if (extractionRow?.status !== "succeeded" || !extractionRow.resultJson) {
      return privateJson({ error: "レシートの読み取り後にカテゴリを保存してください。" }, 409);
    }
    let extraction;
    try { extraction = validateReceiptExtraction(JSON.parse(extractionRow.resultJson)); }
    catch { return privateJson({ error: "レシートの読み取り結果を確認できません。" }, 409); }
    if (extraction.documentKind !== "receipt") {
      return privateJson({ error: "レシートとして読み取れた場合にカテゴリを保存できます。" }, 409);
    }

    await confirmReceiptCategory({ receiptId: id, userId: owner.id, categoryId: parsedBody.categoryId, merchant: extraction.merchant });
    const [state] = await db.select().from(receiptCategory).where(eq(receiptCategory.receiptId, id)).limit(1);
    return privateJson(toPublicCategoryState(state));
  } catch {
    return privateJson({ error: "カテゴリを保存できませんでした。" }, 500);
  }
}
