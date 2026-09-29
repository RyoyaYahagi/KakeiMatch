import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { receipt, receiptRegistration, reconciliationPairRejection, reconciliationResolution, statementTransaction } from "@/db/schema";
import { CATEGORY_LABELS, type CategoryId } from "@/lib/category";
import { createActualReconciliationWriter } from "@/lib/actual-reconciliation-writer";
import { getLatestReconciliationRun } from "@/lib/reconciliation-repository";

export async function getPendingReconciliationCount(userId: string): Promise<number | null> {
  const run = await getLatestReconciliationRun(userId);
  if (!run) return null;
  const [resolutions, rejections] = await Promise.all([
    db.select({ statementTransactionId: reconciliationResolution.statementTransactionId }).from(reconciliationResolution)
      .where(eq(reconciliationResolution.userId, userId)),
    db.select({ statementTransactionId: reconciliationPairRejection.statementTransactionId, receiptId: reconciliationPairRejection.receiptId })
      .from(reconciliationPairRejection).where(eq(reconciliationPairRejection.userId, userId)),
  ]);
  const resolved = new Set(resolutions.map((row) => row.statementTransactionId));
  const rejected = new Set(rejections.map((row) => `${row.statementTransactionId}\0${row.receiptId}`));
  return run.statementResults.filter((result) => result.status === "needs_review" && !resolved.has(result.statementTransactionId)
    && run.candidates.some((candidate) => candidate.statementTransactionId === result.statementTransactionId
      && !rejected.has(`${candidate.statementTransactionId}\0${candidate.receiptId}`))).length;
}

export async function getReconciliationReview(userId: string) {
  const run = await getLatestReconciliationRun(userId);
  if (!run) return null;

  const resolutions = await db.select().from(reconciliationResolution).where(eq(reconciliationResolution.userId, userId));
  const statementIds = [...new Set([...run.statementResults.map((result) => result.statementTransactionId),
    ...resolutions.filter((row) => row.applyStatus !== "applied").map((row) => row.statementTransactionId)])];
  const receiptIds = [...new Set([...run.candidates.map((candidate) => candidate.receiptId),
    ...resolutions.filter((row) => row.applyStatus !== "applied" && row.receiptId).map((row) => row.receiptId!)])];
  const [statements, registrations, rejections] = await Promise.all([
    statementIds.length ? db.select({
      id: statementTransaction.id, kind: statementTransaction.kind, usedDate: statementTransaction.usedDate,
      merchant: statementTransaction.merchant, amountYen: statementTransaction.amountYen, provider: statementTransaction.provider,
    }).from(statementTransaction).where(and(eq(statementTransaction.userId, userId), inArray(statementTransaction.id, statementIds))) : [],
    receiptIds.length ? db.select({
      receiptId: receiptRegistration.receiptId, merchant: receiptRegistration.merchant,
      purchasedDate: receiptRegistration.purchasedDate, amountYen: receiptRegistration.totalAmountYen,
    }).from(receiptRegistration).innerJoin(receipt, eq(receipt.id, receiptRegistration.receiptId))
      .where(and(eq(receipt.ownerUserId, userId), inArray(receiptRegistration.receiptId, receiptIds))) : [],
    db.select({ statementTransactionId: reconciliationPairRejection.statementTransactionId, receiptId: reconciliationPairRejection.receiptId })
      .from(reconciliationPairRejection).where(eq(reconciliationPairRejection.userId, userId)),
  ]);
  const statementById = new Map(statements.map((row) => [row.id, row]));
  const receiptById = new Map(registrations.map((row) => [row.receiptId, row]));
  const resolutionByStatement = new Map(resolutions.map((row) => [row.statementTransactionId, row]));
  const rejected = new Set(rejections.map((row) => `${row.statementTransactionId}\0${row.receiptId}`));
  const candidatesByStatement = new Map<string, typeof run.candidates>();
  for (const candidate of run.candidates) {
    if (rejected.has(`${candidate.statementTransactionId}\0${candidate.receiptId}`)) continue;
    const existing = candidatesByStatement.get(candidate.statementTransactionId) ?? [];
    existing.push(candidate);
    candidatesByStatement.set(candidate.statementTransactionId, existing);
  }

  const items = run.statementResults.flatMap((result) => {
    const statement = statementById.get(result.statementTransactionId);
    if (!statement) return [];
    const resolution = resolutionByStatement.get(result.statementTransactionId);
    if (resolution?.applyStatus === "applied") return [];
    if (result.status === "matched" && !resolution) return [];
    const candidates = (candidatesByStatement.get(result.statementTransactionId) ?? []).flatMap((candidate) => {
      const registration = receiptById.get(candidate.receiptId);
      return registration ? [{
        receiptId: candidate.receiptId, merchant: registration.merchant, purchasedDate: registration.purchasedDate,
        amountYen: registration.amountYen, amountDeltaYen: candidate.amountDeltaYen,
        dateDistanceDays: candidate.dateDistanceDays, reasons: candidate.reasons,
      }] : [];
    });
    const status = result.status === "needs_review" && candidates.length === 0 ? "unmatched_statement" : result.status;
    return [{
      statementTransactionId: result.statementTransactionId, status, statement,
      reasonCodes: result.reasonCodes, candidates,
      resolution: resolution ? {
        id: resolution.id, resolution: resolution.resolution, source: resolution.source,
        status: resolution.applyStatus, lastErrorCode: resolution.errorCode,
      } : null,
    }];
  });
  const included = new Set(items.map((item) => item.statementTransactionId));
  for (const resolution of resolutions) {
    if (resolution.applyStatus === "applied" || included.has(resolution.statementTransactionId)) continue;
    const statement = statementById.get(resolution.statementTransactionId);
    if (!statement) continue;
    items.push({
      statementTransactionId: resolution.statementTransactionId,
      status: resolution.source === "automatic" ? "matched" : resolution.resolution === "same_expense" ? "needs_review" : "unmatched_statement",
      statement, reasonCodes: [], candidates: [],
      resolution: { id: resolution.id, resolution: resolution.resolution, source: resolution.source,
        status: resolution.applyStatus, lastErrorCode: resolution.errorCode },
    });
  }
  const unresolved = items.filter((item) => !item.resolution);
  const reviewCount = unresolved.filter((item) => item.status === "needs_review").length;
  const unmatchedCount = unresolved.filter((item) => item.status === "unmatched_statement").length;
  const failedCount = items.filter((item) => item.resolution?.status === "failed").length;
  const needsOptions = unresolved.some((item) => item.status === "unmatched_statement" && item.statement.kind === "purchase");
  let accounts: { id: string; name: string }[] = [];
  let accountError = false;
  if (needsOptions) {
    try { accounts = await createActualReconciliationWriter({ userId }).listOpenAccounts(); }
    catch { accountError = true; }
  }
  const categories = (Object.entries(CATEGORY_LABELS) as [CategoryId, string][]).map(([id, name]) => ({ id, name }));
  return {
    runId: run.runId,
    completedAt: run.completedAt,
    summary: {
      automatic: run.statementResults.filter((item) => item.status === "matched").length,
      needsReview: reviewCount, unmatchedStatement: unmatchedCount,
      unmatchedReceipt: run.receiptResults.filter((item) => item.status === "unmatched_receipt").length,
      failed: failedCount,
    },
    items: items.sort((a, b) => {
      const priority = (item: typeof a) => item.resolution?.status === "failed" ? 0 : item.status === "needs_review" ? 1 : 2;
      return priority(a) - priority(b) || b.statement.usedDate.localeCompare(a.statement.usedDate);
    }),
    accounts, categories, accountError,
  };
}
