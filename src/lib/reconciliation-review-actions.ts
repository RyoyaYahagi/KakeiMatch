import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { receipt, receiptRegistration, reconciliationPairRejection, reconciliationResolution, statementTransaction } from "@/db/schema";
import { isCategoryId } from "@/lib/category";
import { resolveActualCategory } from "@/lib/actual-category-resolution";
import { createActualReconciliationWriter } from "@/lib/actual-reconciliation-writer";
import {
  claimResolution, createResolution, getLatestReconciliationRun, markResolutionApplied,
  markResolutionFailed, recordPairRejection, rememberMerchantAlias,
  type ReconciliationResolutionRecord,
} from "@/lib/reconciliation-repository";

export class ReconciliationActionError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

const failedMessage = "家計簿への反映に失敗しました。判断内容は保存されています。もう一度お試しください。";

async function ownedStatement(userId: string, statementTransactionId: string) {
  const [row] = await db.select().from(statementTransaction).where(and(
    eq(statementTransaction.userId, userId), eq(statementTransaction.id, statementTransactionId),
  )).limit(1);
  if (!row) throw new ReconciliationActionError("not_found", 404, "明細が見つかりません。");
  return row;
}

async function ownedReceipt(userId: string, receiptId: string) {
  const [row] = await db.select({
    receiptId: receiptRegistration.receiptId, actualTransactionId: receiptRegistration.actualTransactionId,
    merchant: receiptRegistration.merchant, amountYen: receiptRegistration.totalAmountYen,
  }).from(receiptRegistration).innerJoin(receipt, eq(receipt.id, receiptRegistration.receiptId))
    .where(and(eq(receipt.ownerUserId, userId), eq(receiptRegistration.receiptId, receiptId), eq(receiptRegistration.status, "registered")))
    .limit(1);
  if (!row?.actualTransactionId) throw new ReconciliationActionError("not_found", 404, "記録が見つかりません。");
  return { ...row, actualTransactionId: row.actualTransactionId };
}

async function requireLatest(userId: string, runId: string) {
  const latest = await getLatestReconciliationRun(userId);
  if (!latest || latest.runId !== runId) {
    throw new ReconciliationActionError("stale_run", 409, "照合結果が更新されています。画面を更新してください。");
  }
  return latest;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ReconciliationActionError) throw error;
  const code = error instanceof Error ? error.message : "resolution_failed";
  if (code.includes("stale")) throw new ReconciliationActionError("stale_run", 409, "照合結果が更新されています。画面を更新してください。");
  if (code.includes("not_found") || code.includes("not_owned") || code.includes("candidate")) {
    throw new ReconciliationActionError("not_found", 404, "対象が見つかりません。");
  }
  if (code.includes("conflict") || code.includes("resolved") || code.includes("rejected")) {
    throw new ReconciliationActionError("decision_conflict", 409, "この明細はすでに判断されています。画面を更新してください。");
  }
  throw error;
}

export async function confirmSameExpense(input: { userId: string; runId: string; statementTransactionId: string; receiptId: string }) {
  await requireLatest(input.userId, input.runId);
  const [statement, registration] = await Promise.all([
    ownedStatement(input.userId, input.statementTransactionId), ownedReceipt(input.userId, input.receiptId),
  ]);
  let resolution: ReconciliationResolutionRecord;
  try {
    resolution = await createResolution({
      ...input, resolution: "same_expense", source: "user", statementAmountYen: statement.amountYen,
    });
  } catch (error) { mapRepositoryError(error); }
  if (resolution.applyStatus === "applied") return { status: "applied", resolutionId: resolution.id };
  if (statement.merchant !== registration.merchant) {
    await rememberMerchantAlias({ userId: input.userId, merchant: statement.merchant, aliasMerchant: registration.merchant });
  }
  return applyResolution(input.userId, resolution);
}

export async function rejectCandidate(input: { userId: string; runId: string; statementTransactionId: string; receiptId: string }) {
  await requireLatest(input.userId, input.runId);
  try { await recordPairRejection(input); }
  catch (error) { mapRepositoryError(error); }
  return { status: "rejected" };
}

export async function confirmNoReceipt(input: {
  userId: string; runId: string; statementTransactionId: string; categoryId: string; actualAccountId: string;
}) {
  const latest = await requireLatest(input.userId, input.runId);
  const statement = await ownedStatement(input.userId, input.statementTransactionId);
  if (statement.kind !== "purchase" || !latest.statementResults.some((row) => row.statementTransactionId === statement.id && row.status !== "matched")) {
    throw new ReconciliationActionError("not_available", 409, "この明細は登録できません。");
  }
  const candidateIds = latest.candidates.filter((candidate) => candidate.statementTransactionId === statement.id).map((candidate) => candidate.receiptId);
  if (candidateIds.length) {
    const rejected = await db.select({ receiptId: reconciliationPairRejection.receiptId }).from(reconciliationPairRejection)
      .where(and(eq(reconciliationPairRejection.userId, input.userId), eq(reconciliationPairRejection.statementTransactionId, statement.id)));
    const rejectedIds = new Set(rejected.map((row) => row.receiptId));
    if (candidateIds.some((receiptId) => !rejectedIds.has(receiptId))) {
      throw new ReconciliationActionError("candidates_remaining", 409, "先に似た支出を確認してください。");
    }
  }
  if (!isCategoryId(input.categoryId) || !input.actualAccountId) {
    throw new ReconciliationActionError("invalid_input", 400, "カテゴリと支払元を選択してください。");
  }
  const writer = createActualReconciliationWriter({ userId: input.userId });
  const accounts = await writer.listOpenAccounts();
  if (!accounts.some((account) => account.id === input.actualAccountId)) {
    throw new ReconciliationActionError("account_unavailable", 409, "選択した支払元を利用できません。");
  }
  await resolveActualCategory({ userId: input.userId, categoryId: input.categoryId, categories: await writer.listExpenseCategories() });
  let resolution: ReconciliationResolutionRecord;
  try {
    resolution = await createResolution({
      ...input, resolution: "no_receipt", source: "user", statementAmountYen: statement.amountYen,
    });
  } catch (error) { mapRepositoryError(error); }
  if (resolution.applyStatus === "applied") return { status: "applied", resolutionId: resolution.id };
  return applyResolution(input.userId, resolution);
}

export async function retryResolution(input: { userId: string; runId: string; resolutionId: string }) {
  await requireLatest(input.userId, input.runId);
  const [resolution] = await db.select().from(reconciliationResolution).where(and(
    eq(reconciliationResolution.userId, input.userId), eq(reconciliationResolution.id, input.resolutionId),
  )).limit(1);
  if (!resolution) throw new ReconciliationActionError("not_found", 404, "判断記録が見つかりません。");
  return applyResolution(input.userId, resolution as ReconciliationResolutionRecord);
}

async function applyResolution(userId: string, resolution: ReconciliationResolutionRecord) {
  const claim = await claimResolution(userId, resolution.id);
  if (claim.status === "applied") return { status: "applied", resolutionId: resolution.id };
  if (claim.status !== "claimed") throw new ReconciliationActionError("apply_busy", 409, "家計簿へ反映中です。しばらくしてから確認してください。");
  const writer = createActualReconciliationWriter({ userId });
  try {
    let actualTransactionId: string;
    if (claim.resolution.resolution === "same_expense") {
      if (!claim.resolution.receiptId) throw new Error("receipt_required");
      const registration = await ownedReceipt(userId, claim.resolution.receiptId);
      await writer.applyTransactionUpdates([{
        transactionId: registration.actualTransactionId, cleared: true,
        ...(claim.resolution.source === "user" && registration.amountYen !== claim.resolution.statementAmountYen
          ? { amountYen: -claim.resolution.statementAmountYen } : {}),
      }]);
      actualTransactionId = registration.actualTransactionId;
    } else {
      const statement = await ownedStatement(userId, claim.resolution.statementTransactionId);
      if (!isCategoryId(claim.resolution.categoryId) || !claim.resolution.actualAccountId || !claim.resolution.importedId || statement.kind !== "purchase") {
        throw new Error("resolution_snapshot_invalid");
      }
      const accounts = await writer.listOpenAccounts();
      if (!accounts.some((account) => account.id === claim.resolution.actualAccountId)) throw new Error("account_unavailable");
      const categoryId = await resolveActualCategory({
        userId, categoryId: claim.resolution.categoryId, categories: await writer.listExpenseCategories(),
      });
      let transaction = await writer.findByImportedId(claim.resolution.importedId);
      if (!transaction) transaction = await writer.importNoReceipt({
        accountId: claim.resolution.actualAccountId, date: statement.usedDate,
        amountYen: -claim.resolution.statementAmountYen, merchant: statement.merchant,
        categoryId, importedId: claim.resolution.importedId,
      });
      if (!transaction || transaction.importedId !== claim.resolution.importedId
        || transaction.accountId !== claim.resolution.actualAccountId || transaction.date !== statement.usedDate
        || transaction.amountYen !== -claim.resolution.statementAmountYen || transaction.payeeName !== statement.merchant
        || transaction.categoryId !== categoryId || !transaction.cleared) throw new Error("actual_readback_mismatch");
      actualTransactionId = transaction.id;
    }
    if (!await markResolutionApplied({ userId, resolutionId: resolution.id, token: claim.token, actualTransactionId })) throw new Error("claim_lost");
    return { status: "applied", resolutionId: resolution.id };
  } catch {
    await markResolutionFailed({ userId, resolutionId: resolution.id, token: claim.token, errorCode: "actual_apply_failed" });
    throw new ReconciliationActionError("actual_apply_failed", 503, failedMessage);
  }
}

export async function applyAutomaticMatches(userId: string, runId: string) {
  const latest = await requireLatest(userId, runId);
  const claims: { resolution: ReconciliationResolutionRecord; token: string; actualTransactionId: string }[] = [];
  for (const result of latest.statementResults) {
    if (result.status !== "matched" || !result.matchedReceiptId) continue;
    const statement = await ownedStatement(userId, result.statementTransactionId);
    const registration = await ownedReceipt(userId, result.matchedReceiptId);
    const resolution = await createResolution({
      userId, runId, statementTransactionId: statement.id, resolution: "same_expense",
      source: "automatic", receiptId: result.matchedReceiptId, statementAmountYen: statement.amountYen,
    });
    const claim = await claimResolution(userId, resolution.id);
    if (claim.status === "claimed") claims.push({ resolution, token: claim.token, actualTransactionId: registration.actualTransactionId });
  }
  if (claims.length === 0) return;
  try {
    await createActualReconciliationWriter({ userId }).applyTransactionUpdates(
      claims.map((claim) => ({ transactionId: claim.actualTransactionId, cleared: true })),
    );
    for (const claim of claims) {
      await markResolutionApplied({ userId, resolutionId: claim.resolution.id, token: claim.token, actualTransactionId: claim.actualTransactionId });
    }
  } catch {
    for (const claim of claims) {
      await markResolutionFailed({ userId, resolutionId: claim.resolution.id, token: claim.token, errorCode: "actual_apply_failed" });
    }
  }
}
