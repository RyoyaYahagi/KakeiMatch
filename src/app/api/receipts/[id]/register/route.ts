import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { receipt } from "@/db/schema";
import { ActualCategorySetupRequiredError, resolveActualCategory } from "@/lib/actual-category-resolution";
import { createActualReceiptWriterForUser } from "@/lib/actual-receipt-writer";
import { getCurrentUser } from "@/lib/current-user";
import { getConfirmedReceiptCategory } from "@/lib/receipt-category-state";
import { receiptRegistrationInputSchema } from "@/lib/receipt-registration-input";
import {
  claimReceiptRegistration, getReceiptRegistrationDraft, markReceiptRegistrationFailed,
  markReceiptRegistrationSucceeded, rememberLastUsedActualAccount, saveReceiptRegistrationDraft,
} from "@/lib/receipt-registration-state";

export const runtime = "nodejs";

function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function notFound() { return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } }); }

/** Register exactly one confirmed receipt in the Budget resolved from the session user. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = await getCurrentUser(request.headers);
  if (!owner) return privateJson({ code: "unauthenticated", error: "ログインしてください。" }, 401);
  const { id } = await context.params;
  const [owned] = await db.select({ id: receipt.id }).from(receipt)
    .where(and(eq(receipt.id, id), eq(receipt.ownerUserId, owner.id))).limit(1);
  if (!owned) return notFound();

  const existing = await getReceiptRegistrationDraft(owner.id, id);
  if (existing?.status === "registered") return privateJson({ status: "registered" });

  let finalAccountId: string;
  let finalCategoryId;
  if (existing?.status === "registering" || (existing?.status === "failed" && existing.lastErrorCode === "actual_write_uncertain")) {
    // A crashed process may have written Actual already. Recover its immutable snapshot.
    finalAccountId = existing.actualAccountId;
    finalCategoryId = existing.categoryId;
  } else {
    let input;
    try { input = receiptRegistrationInputSchema.parse(await request.json()); }
    catch { return privateJson({ code: "invalid_input", error: "店名・日付・金額・支払元を確認してください。" }, 400); }

    const category = await getConfirmedReceiptCategory(owner.id, id);
    if (!category) return privateJson({ code: "category_unconfirmed", error: "カテゴリを確認して保存してください。" }, 409);
    finalAccountId = input.actualAccountId;
    finalCategoryId = category.categoryId;
    try {
      await saveReceiptRegistrationDraft({ userId: owner.id, receiptId: id, ...input, categoryId: category.categoryId });
    } catch (error) {
      if (error instanceof Error && error.message === "registration_not_editable") {
        return privateJson({ code: "registration_busy", error: "登録中です。しばらくしてから確認してください。" }, 409);
      }
      return privateJson({ code: "draft_unavailable", error: "入力内容を保存できませんでした。" }, 500);
    }
  }

  try {
    const writer = createActualReceiptWriterForUser(owner.id);
    const accounts = await writer.listOpenAccounts();
    if (!accounts.some((account) => account.id === finalAccountId)) {
      return privateJson({ code: "account_unavailable", error: "選択した支払元を利用できません。もう一度選択してください。" }, 409);
    }
    const actualCategoryId = await resolveActualCategory({
      userId: owner.id, categoryId: finalCategoryId, categories: await writer.listExpenseCategories(),
    });

    const claim = await claimReceiptRegistration(owner.id, id);
    if (claim.status === "registered") return privateJson({ status: "registered" });
    if (claim.status !== "claimed") {
      return privateJson({ code: "registration_busy", error: "登録中です。しばらくしてから確認してください。" }, 409);
    }

    let actualTransactionMayExist = false;
    try {
      let transaction = await writer.findByImportedId(claim.importedId);
      actualTransactionMayExist = transaction !== null;
      if (!transaction) {
        actualTransactionMayExist = true;
        await writer.importReceipt({
          accountId: claim.actualAccountId, date: claim.purchasedDate,
          amountYen: -claim.totalAmountYen, merchant: claim.merchant,
          categoryId: actualCategoryId, importedId: claim.importedId,
        });
        transaction = await writer.findByImportedId(claim.importedId);
      }
      if (!transaction || transaction.accountId !== claim.actualAccountId || transaction.date !== claim.purchasedDate
        || transaction.amountYen !== -claim.totalAmountYen || transaction.payeeName !== claim.merchant
        || transaction.importedId !== claim.importedId) {
        throw new Error("actual_readback_mismatch");
      }
      if (transaction.categoryId !== actualCategoryId || transaction.cleared) {
        await writer.updateReceipt(transaction.id, {
          ...(transaction.categoryId !== actualCategoryId ? { categoryId: actualCategoryId } : {}),
          ...(transaction.cleared ? { cleared: false } : {}),
        });
        transaction = await writer.findByImportedId(claim.importedId);
      }
      if (!transaction || transaction.id.length === 0 || transaction.accountId !== claim.actualAccountId
        || transaction.date !== claim.purchasedDate || transaction.amountYen !== -claim.totalAmountYen
        || transaction.payeeName !== claim.merchant || transaction.categoryId !== actualCategoryId || transaction.cleared) {
        throw new Error("actual_readback_mismatch");
      }
      const saved = await markReceiptRegistrationSucceeded({ receiptId: id, token: claim.token }, transaction.id);
      if (!saved) throw new Error("claim_lost");
      // Preference failure cannot turn an already registered transaction into a failed registration.
      try { await rememberLastUsedActualAccount(owner.id, claim.actualAccountId); }
      catch { console.warn("Could not update last-used account preference."); }
      return privateJson({ status: "registered" });
    } catch {
      try {
        await markReceiptRegistrationFailed({ receiptId: id, token: claim.token }, actualTransactionMayExist ? "actual_write_uncertain" : "registration_failed");
      } catch {
        console.warn("Could not update receipt registration failure state.");
      }
      return privateJson({ code: "registration_failed", error: "家計簿に登録できませんでした。入力内容は保存されています。もう一度お試しください。" }, 503);
    }
  } catch (error) {
    if (error instanceof ActualCategorySetupRequiredError) {
      return privateJson({ code: "category_mapping_required", error: "カテゴリの連携設定が必要です。管理者に確認してください。" }, 409);
    }
    return privateJson({ code: "registration_unavailable", error: "家計簿に登録できませんでした。入力内容は保存されています。もう一度お試しください。" }, 503);
  }
}
