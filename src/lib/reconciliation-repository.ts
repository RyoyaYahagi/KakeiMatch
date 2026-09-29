import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { normalizeReconciliationMerchant } from "@/lib/reconciliation-engine";
import {
  merchantAlias, receipt, receiptRegistration, reconciliationCandidate,
  reconciliationReceiptResult, reconciliationRun, reconciliationStatementResult,
  reconciliationPairRejection, reconciliationResolution, statementTransaction,
} from "@/db/schema";

export interface ReconciliationStatementInput {
  statementTransactionId: string;
  provider: string;
  externalId: string | null;
  kind: string;
  usedDate: string;
  postedDate: string | null;
  merchant: string;
  amountYen: number;
  paymentMethod: string | null;
}

export interface ReconciliationReceiptInput {
  receiptId: string;
  actualTransactionId: string;
  merchant: string;
  purchasedDate: string;
  amountYen: number;
  actualAccountId: string;
}

export interface ReconciliationAliasInput {
  normalizedMerchant: string;
  normalizedAlias: string;
}

export type ReconciliationResolutionRecord = {
  id: string; userId: string; statementTransactionId: string; runId: string;
  resolution: "same_expense" | "no_receipt"; source: "automatic" | "user";
  receiptId: string | null; categoryId: string | null; actualAccountId: string | null;
  importedId: string | null; applyStatus: "pending" | "processing" | "applied" | "failed";
  actualTransactionId: string | null; statementAmountYen: number; errorCode: string | null;
  claimToken: string | null; claimExpiresAt: Date | null; createdAt: Date; updatedAt: Date; appliedAt: Date | null;
};

export type CreateResolutionInput = {
  userId: string; runId: string; statementTransactionId: string;
  resolution: "same_expense" | "no_receipt"; source: "automatic" | "user";
  receiptId?: string | null; statementAmountYen: number;
  categoryId?: string | null; actualAccountId?: string | null;
};

export interface ReconciliationCandidateInput {
  statementTransactionId: string;
  receiptId: string;
  rank: number;
  score: number;
  amountDeltaYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
  reasons: string[];
}

export interface ReconciliationStatementResultInput {
  statementTransactionId: string;
  status: "matched" | "needs_review" | "unmatched_statement";
  matchedReceiptId?: string | null;
  reasonCodes: string[];
}

export interface ReconciliationReceiptResultInput {
  receiptId: string;
  status: "matched" | "needs_review" | "unmatched_receipt";
  matchedStatementTransactionId?: string | null;
  reasonCodes: string[];
}

export interface SaveReconciliationRunInput {
  userId: string;
  ruleVersion: string;
  candidates: ReconciliationCandidateInput[];
  statementResults: ReconciliationStatementResultInput[];
  receiptResults: ReconciliationReceiptResultInput[];
}

export interface LatestReconciliationRun {
  runId: string;
  ruleVersion: string;
  createdAt: string;
  completedAt: string;
  statementResults: ReconciliationStatementResultInput[];
  receiptResults: ReconciliationReceiptResultInput[];
  candidates: ReconciliationCandidateInput[];
}

/** Returns only confirmed Issue #10 values and canonical Issue #11 fields owned by userId. */
export async function getReconciliationInputs(userId: string): Promise<{
  statements: ReconciliationStatementInput[];
  receipts: ReconciliationReceiptInput[];
  aliases: ReconciliationAliasInput[];
  excludedStatementIds: string[];
  excludedReceiptIds: string[];
  rejectedPairs: string[];
}> {
  const statementRows = await db.select({
    statementTransactionId: statementTransaction.id,
    provider: statementTransaction.provider,
    externalId: statementTransaction.externalId,
    kind: statementTransaction.kind,
    usedDate: statementTransaction.usedDate,
    postedDate: statementTransaction.postedDate,
    merchant: statementTransaction.merchant,
    amountYen: statementTransaction.amountYen,
    paymentMethod: statementTransaction.paymentMethod,
  }).from(statementTransaction).where(eq(statementTransaction.userId, userId))
    .orderBy(statementTransaction.usedDate, statementTransaction.id);

  const receiptRows = await db.select({
    receiptId: receiptRegistration.receiptId,
    actualTransactionId: receiptRegistration.actualTransactionId,
    merchant: receiptRegistration.merchant,
    purchasedDate: receiptRegistration.purchasedDate,
    amountYen: receiptRegistration.totalAmountYen,
    actualAccountId: receiptRegistration.actualAccountId,
  }).from(receiptRegistration).innerJoin(receipt, eq(receipt.id, receiptRegistration.receiptId))
    .where(and(
      eq(receipt.ownerUserId, userId),
      eq(receiptRegistration.status, "registered"),
    )).orderBy(receiptRegistration.purchasedDate, receiptRegistration.receiptId);

  const aliases = await db.select({
    normalizedMerchant: merchantAlias.normalizedMerchant,
    normalizedAlias: merchantAlias.normalizedAlias,
  }).from(merchantAlias).where(eq(merchantAlias.userId, userId))
    .orderBy(merchantAlias.normalizedMerchant, merchantAlias.normalizedAlias);

  const resolutions = await db.select({ statementTransactionId: reconciliationResolution.statementTransactionId,
    resolution: reconciliationResolution.resolution, receiptId: reconciliationResolution.receiptId })
    .from(reconciliationResolution).where(eq(reconciliationResolution.userId, userId));
  const rejected = await db.select({ statementTransactionId: reconciliationPairRejection.statementTransactionId,
    receiptId: reconciliationPairRejection.receiptId }).from(reconciliationPairRejection)
    .where(eq(reconciliationPairRejection.userId, userId));

  return {
    statements: statementRows,
    // Filter the nullable type at the DB boundary. Registered rows should always have an Actual ID.
    receipts: receiptRows.filter((row): row is typeof row & { actualTransactionId: string } => Boolean(row.actualTransactionId)),
    aliases,
    excludedStatementIds: resolutions.map((row) => row.statementTransactionId),
    excludedReceiptIds: resolutions.filter((row) => row.resolution === "same_expense" && row.receiptId)
      .map((row) => row.receiptId!),
    rejectedPairs: rejected.map((row) => `${row.statementTransactionId}\0${row.receiptId}`),
  };
}

/** Persists a complete immutable snapshot atomically. Machine-created statuses exclude `confirmed`. */
export async function saveReconciliationRun(input: SaveReconciliationRunInput): Promise<string> {
  if (!input.userId.trim() || !input.ruleVersion.trim()) throw new Error("invalid_reconciliation_run");
  validateResultInput(input);
  const runId = randomUUID();
  let now = new Date();
  db.transaction((tx) => {
    const statementIds = input.statementResults.map((result) => result.statementTransactionId);
    const receiptIds = input.receiptResults.map((result) => result.receiptId);
    const ownedStatements = statementIds.length ? tx.select({ id: statementTransaction.id }).from(statementTransaction)
      .where(and(eq(statementTransaction.userId, input.userId), inArray(statementTransaction.id, statementIds))).all() : [];
    const ownedReceipts = receiptIds.length ? tx.select({ id: receipt.id }).from(receipt)
      .where(and(eq(receipt.ownerUserId, input.userId), inArray(receipt.id, receiptIds))).all() : [];
    if (ownedStatements.length !== statementIds.length || ownedReceipts.length !== receiptIds.length) throw new Error("reconciliation_source_not_owned");
    const latest = tx.select({ completedAt: reconciliationRun.completedAt }).from(reconciliationRun)
      .where(and(eq(reconciliationRun.userId, input.userId), eq(reconciliationRun.status, "completed")))
      .orderBy(desc(reconciliationRun.completedAt)).limit(1).get();
    if (latest?.completedAt && now.getTime() <= latest.completedAt.getTime()) now = new Date(latest.completedAt.getTime() + 1);
    const scoreByPair = new Map(input.candidates.map((candidate) => [`${candidate.statementTransactionId}\0${candidate.receiptId}`, candidate.score]));
    tx.insert(reconciliationRun).values({
      id: runId, userId: input.userId, ruleVersion: input.ruleVersion,
      status: "completed", createdAt: now, completedAt: now,
    }).run();
    for (const result of input.statementResults) {
      tx.insert(reconciliationStatementResult).values({
        id: randomUUID(), runId, userId: input.userId,
        statementTransactionId: result.statementTransactionId,
        status: result.status, matchedReceiptId: result.matchedReceiptId ?? null,
        score: result.matchedReceiptId ? scoreByPair.get(`${result.statementTransactionId}\0${result.matchedReceiptId}`) ?? null : null,
        reasonCodesJson: JSON.stringify(result.reasonCodes),
      }).run();
    }
    for (const result of input.receiptResults) {
      tx.insert(reconciliationReceiptResult).values({
        id: randomUUID(), runId, userId: input.userId,
        receiptId: result.receiptId, status: result.status,
        statementTransactionId: result.matchedStatementTransactionId ?? null,
        score: result.matchedStatementTransactionId ? scoreByPair.get(`${result.matchedStatementTransactionId}\0${result.receiptId}`) ?? null : null,
        reasonCodesJson: JSON.stringify(result.reasonCodes),
      }).run();
    }
    for (const candidate of input.candidates) {
      tx.insert(reconciliationCandidate).values({
        id: randomUUID(), runId, userId: input.userId,
        statementTransactionId: candidate.statementTransactionId,
        receiptId: candidate.receiptId, rank: candidate.rank,
        score: candidate.score, amountDeltaYen: candidate.amountDeltaYen,
        dateDistanceDays: candidate.dateDistanceDays,
        merchantSimilarity: candidate.merchantSimilarity,
        amountExact: candidate.reasons.includes("amount_exact"),
        dateClose: candidate.reasons.includes("date_close"),
        merchantSimilar: candidate.reasons.includes("merchant_similar") || candidate.reasons.includes("merchant_alias_match"),
        reasonCodesJson: JSON.stringify(candidate.reasons),
      }).run();
    }
  });
  return runId;
}

/** Latest completed snapshot for the authenticated user. */
export async function getLatestReconciliationRun(userId: string): Promise<LatestReconciliationRun | null> {
  const [run] = await db.select().from(reconciliationRun).where(and(
    eq(reconciliationRun.userId, userId), eq(reconciliationRun.status, "completed"),
  )).orderBy(desc(reconciliationRun.completedAt), desc(reconciliationRun.id)).limit(1);
  if (!run || !run.completedAt) return null;
  const statementRows = await db.select().from(reconciliationStatementResult)
    .where(and(eq(reconciliationStatementResult.userId, userId), eq(reconciliationStatementResult.runId, run.id)))
    .orderBy(reconciliationStatementResult.statementTransactionId);
  const receiptRows = await db.select().from(reconciliationReceiptResult)
    .where(and(eq(reconciliationReceiptResult.userId, userId), eq(reconciliationReceiptResult.runId, run.id)))
    .orderBy(reconciliationReceiptResult.receiptId);
  const candidateRows = await db.select().from(reconciliationCandidate)
    .where(and(eq(reconciliationCandidate.userId, userId), eq(reconciliationCandidate.runId, run.id)))
    .orderBy(reconciliationCandidate.statementTransactionId, reconciliationCandidate.rank);
  return {
    runId: run.id,
    ruleVersion: run.ruleVersion,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt.toISOString(),
    statementResults: statementRows.map((row) => ({
      statementTransactionId: row.statementTransactionId,
      status: row.status as ReconciliationStatementResultInput["status"],
      matchedReceiptId: row.matchedReceiptId,
      score: row.score,
      reasonCodes: parseReasons(row.reasonCodesJson),
    })),
    receiptResults: receiptRows.map((row) => ({
      receiptId: row.receiptId,
      status: row.status as ReconciliationReceiptResultInput["status"],
      matchedStatementTransactionId: row.statementTransactionId,
      score: row.score,
      reasonCodes: parseReasons(row.reasonCodesJson),
    })),
    candidates: candidateRows.map((row) => ({
      statementTransactionId: row.statementTransactionId,
      receiptId: row.receiptId,
      rank: row.rank,
      score: row.score,
      amountDeltaYen: row.amountDeltaYen,
      dateDistanceDays: row.dateDistanceDays,
      merchantSimilarity: row.merchantSimilarity,
      reasons: parseReasons(row.reasonCodesJson),
    })),
  };
}

/** Source facts are fetched from canonical statement and confirmed receipt rows, scoped to the owner. */
export async function getReviewSource(userId: string, statementTransactionId: string, receiptId?: string) {
  const [statement] = await db.select().from(statementTransaction).where(and(
    eq(statementTransaction.userId, userId), eq(statementTransaction.id, statementTransactionId),
  )).limit(1);
  if (!statement) return null;
  const registration = receiptId ? await db.select({ receiptId: receiptRegistration.receiptId,
    merchant: receiptRegistration.merchant, purchasedDate: receiptRegistration.purchasedDate,
    amountYen: receiptRegistration.totalAmountYen, categoryId: receiptRegistration.categoryId,
    actualAccountId: receiptRegistration.actualAccountId, actualTransactionId: receiptRegistration.actualTransactionId,
  }).from(receiptRegistration).innerJoin(receipt, eq(receipt.id, receiptRegistration.receiptId)).where(and(
    eq(receipt.ownerUserId, userId), eq(receiptRegistration.status, "registered"),
    eq(receiptRegistration.receiptId, receiptId),
  )).get() ?? null : null;
  return { statement, registration };
}

/** Inserts a user decision after validating its source against the user's current latest immutable snapshot. */
export async function createResolution(input: CreateResolutionInput): Promise<ReconciliationResolutionRecord> {
  if (!input.userId.trim() || !Number.isSafeInteger(input.statementAmountYen) || input.statementAmountYen < 0) throw new Error("invalid_reconciliation_resolution");
  if (input.resolution === "no_receipt" && (!input.categoryId?.trim() || !input.actualAccountId?.trim())) throw new Error("no_receipt_category_account_required");
  const importedId = input.resolution === "no_receipt" ? `kakeimatch:statement:${input.statementTransactionId}` : null;
  const result = db.transaction((tx) => {
    const latest = tx.select({ id: reconciliationRun.id }).from(reconciliationRun).where(and(
      eq(reconciliationRun.userId, input.userId), eq(reconciliationRun.status, "completed"),
    )).orderBy(desc(reconciliationRun.completedAt), desc(reconciliationRun.id)).limit(1).get();
    if (!latest || latest.id !== input.runId) throw new Error("reconciliation_run_stale");
    const existing = tx.select().from(reconciliationResolution).where(and(
      eq(reconciliationResolution.userId, input.userId),
      eq(reconciliationResolution.statementTransactionId, input.statementTransactionId),
    )).get();
    if (existing) {
      if (existing.runId !== input.runId || existing.resolution !== input.resolution || existing.receiptId !== (input.receiptId ?? null)) throw new Error("reconciliation_resolution_conflict");
      return existing;
    }
    const statement = tx.select({ id: statementTransaction.id, amountYen: statementTransaction.amountYen, kind: statementTransaction.kind })
      .from(statementTransaction).where(and(eq(statementTransaction.userId, input.userId), eq(statementTransaction.id, input.statementTransactionId))).get();
    if (!statement || statement.amountYen !== input.statementAmountYen) throw new Error("reconciliation_statement_not_owned");
    const statementResult = tx.select().from(reconciliationStatementResult).where(and(
      eq(reconciliationStatementResult.userId, input.userId), eq(reconciliationStatementResult.runId, input.runId),
      eq(reconciliationStatementResult.statementTransactionId, input.statementTransactionId),
    )).get();
    if (!statementResult) throw new Error("reconciliation_statement_not_in_run");
    if (input.source === "user" && input.resolution === "same_expense" && statementResult.status !== "needs_review") {
      throw new Error("reconciliation_pair_not_candidate");
    }
    const receiptId = input.receiptId ?? null;
    if (input.resolution === "same_expense") {
      if (!receiptId || statement.kind !== "purchase") throw new Error("reconciliation_receipt_required");
      const ownedRegistration = tx.select({ id: receiptRegistration.receiptId }).from(receiptRegistration).innerJoin(receipt,
        eq(receipt.id, receiptRegistration.receiptId)).where(and(eq(receipt.ownerUserId, input.userId),
        eq(receiptRegistration.receiptId, receiptId), eq(receiptRegistration.status, "registered"))).get();
      if (!ownedRegistration) throw new Error("reconciliation_receipt_not_owned");
      const candidate = tx.select({ id: reconciliationCandidate.id }).from(reconciliationCandidate).where(and(
        eq(reconciliationCandidate.userId, input.userId), eq(reconciliationCandidate.runId, input.runId),
        eq(reconciliationCandidate.statementTransactionId, input.statementTransactionId), eq(reconciliationCandidate.receiptId, receiptId),
      )).get();
      const automaticPair = input.source === "automatic" && statementResult.status === "matched" && statementResult.matchedReceiptId === receiptId;
      if (!candidate && !automaticPair) throw new Error("reconciliation_pair_not_candidate");
      const rejected = tx.select({ id: reconciliationPairRejection.id }).from(reconciliationPairRejection).where(and(
        eq(reconciliationPairRejection.userId, input.userId), eq(reconciliationPairRejection.statementTransactionId, input.statementTransactionId),
        eq(reconciliationPairRejection.receiptId, receiptId),
      )).get();
      if (rejected) throw new Error("reconciliation_pair_rejected");
    } else {
      if (statement.kind !== "purchase") throw new Error("refund_not_supported");
      if (receiptId) throw new Error("unexpected_reconciliation_receipt");
      if (statementResult.status === "matched") throw new Error("reconciliation_statement_already_matched");
      const candidates = tx.select({ receiptId: reconciliationCandidate.receiptId }).from(reconciliationCandidate).where(and(
        eq(reconciliationCandidate.userId, input.userId), eq(reconciliationCandidate.runId, input.runId),
        eq(reconciliationCandidate.statementTransactionId, input.statementTransactionId),
      )).all();
      const liveCandidate = candidates.some((candidate) => !tx.select({ id: reconciliationPairRejection.id }).from(reconciliationPairRejection).where(and(
        eq(reconciliationPairRejection.userId, input.userId), eq(reconciliationPairRejection.statementTransactionId, input.statementTransactionId),
        eq(reconciliationPairRejection.receiptId, candidate.receiptId),
      )).get());
      if (statementResult.status === "needs_review" && liveCandidate) throw new Error("reconciliation_candidates_remain");
    }
    const now = new Date();
    const id = randomUUID();
    tx.insert(reconciliationResolution).values({ id, userId: input.userId, statementTransactionId: input.statementTransactionId,
      runId: input.runId, resolution: input.resolution, source: input.source, receiptId,
      categoryId: input.resolution === "no_receipt" ? input.categoryId! : null,
      actualAccountId: input.resolution === "no_receipt" ? input.actualAccountId! : null,
      importedId, applyStatus: "pending", actualTransactionId: null, statementAmountYen: input.statementAmountYen,
      errorCode: null, claimToken: null, claimExpiresAt: null, createdAt: now, updatedAt: now, appliedAt: null,
    }).run();
    return tx.select().from(reconciliationResolution).where(eq(reconciliationResolution.id, id)).get()!;
  });
  return result as ReconciliationResolutionRecord;
}

/** Persists a rejection for one candidate pair; it never resolves the statement itself. */
export async function recordPairRejection(input: { userId: string; runId: string; statementTransactionId: string; receiptId: string }): Promise<void> {
  const now = new Date();
  db.transaction((tx) => {
    const latest = tx.select({ id: reconciliationRun.id }).from(reconciliationRun).where(and(
      eq(reconciliationRun.userId, input.userId), eq(reconciliationRun.status, "completed"),
    )).orderBy(desc(reconciliationRun.completedAt), desc(reconciliationRun.id)).limit(1).get();
    if (!latest || latest.id !== input.runId) throw new Error("reconciliation_run_stale");
    const candidate = tx.select({ id: reconciliationCandidate.id }).from(reconciliationCandidate).where(and(
      eq(reconciliationCandidate.userId, input.userId), eq(reconciliationCandidate.runId, input.runId),
      eq(reconciliationCandidate.statementTransactionId, input.statementTransactionId), eq(reconciliationCandidate.receiptId, input.receiptId),
    )).get();
    if (!candidate) throw new Error("reconciliation_pair_not_candidate");
    const statementResult = tx.select({ status: reconciliationStatementResult.status }).from(reconciliationStatementResult).where(and(
      eq(reconciliationStatementResult.userId, input.userId), eq(reconciliationStatementResult.runId, input.runId),
      eq(reconciliationStatementResult.statementTransactionId, input.statementTransactionId),
    )).get();
    if (statementResult?.status !== "needs_review") throw new Error("reconciliation_pair_not_reviewable");
    const resolved = tx.select({ id: reconciliationResolution.id }).from(reconciliationResolution).where(and(
      eq(reconciliationResolution.userId, input.userId), eq(reconciliationResolution.statementTransactionId, input.statementTransactionId),
    )).get();
    if (resolved) throw new Error("reconciliation_resolution_conflict");
    tx.insert(reconciliationPairRejection).values({ id: randomUUID(), userId: input.userId,
      statementTransactionId: input.statementTransactionId, receiptId: input.receiptId, runId: input.runId, createdAt: now,
    }).onConflictDoNothing({ target: [reconciliationPairRejection.userId, reconciliationPairRejection.statementTransactionId, reconciliationPairRejection.receiptId] }).run();
  });
}

export async function getResolutionStates(userId: string): Promise<ReconciliationResolutionRecord[]> {
  return await db.select().from(reconciliationResolution).where(eq(reconciliationResolution.userId, userId))
    .orderBy(reconciliationResolution.createdAt) as ReconciliationResolutionRecord[];
}

export async function claimResolution(userId: string, resolutionId: string): Promise<
  { status: "claimed"; token: string; resolution: ReconciliationResolutionRecord } | { status: "busy" | "applied" | "not_found" }
> {
  return db.transaction((tx) => {
    const row = tx.select().from(reconciliationResolution).where(and(eq(reconciliationResolution.userId, userId), eq(reconciliationResolution.id, resolutionId))).get();
    if (!row) return { status: "not_found" } as const;
    if (row.applyStatus === "applied") return { status: "applied" } as const;
    const now = new Date();
    if (row.applyStatus === "processing" && row.claimExpiresAt && row.claimExpiresAt > now) return { status: "busy" } as const;
    const token = randomUUID();
    const expires = new Date(now.getTime() + 120_000);
    const changed = tx.update(reconciliationResolution).set({ applyStatus: "processing", claimToken: token,
      claimExpiresAt: expires, errorCode: null, updatedAt: now }).where(and(
      eq(reconciliationResolution.id, resolutionId), eq(reconciliationResolution.userId, userId),
      or(eq(reconciliationResolution.applyStatus, "pending"), eq(reconciliationResolution.applyStatus, "failed"),
        and(eq(reconciliationResolution.applyStatus, "processing"), or(isNull(reconciliationResolution.claimExpiresAt), sql`${reconciliationResolution.claimExpiresAt} <= ${now.getTime()}`))),
    )).run();
    if (changed.changes === 0) return { status: "busy" } as const;
    const current = tx.select().from(reconciliationResolution).where(eq(reconciliationResolution.id, resolutionId)).get()!;
    return { status: "claimed", token, resolution: current as ReconciliationResolutionRecord } as const;
  });
}

export async function markResolutionApplied(input: { userId: string; resolutionId: string; token: string; actualTransactionId: string }): Promise<boolean> {
  const now = new Date();
  const updated = await db.update(reconciliationResolution).set({ applyStatus: "applied", actualTransactionId: input.actualTransactionId,
    errorCode: null, claimToken: null, claimExpiresAt: null, appliedAt: now, updatedAt: now }).where(and(
    eq(reconciliationResolution.userId, input.userId), eq(reconciliationResolution.id, input.resolutionId),
    eq(reconciliationResolution.applyStatus, "processing"), eq(reconciliationResolution.claimToken, input.token),
  ));
  return updated.changes > 0;
}

export async function markResolutionFailed(input: { userId: string; resolutionId: string; token: string; errorCode: string }): Promise<boolean> {
  const updated = await db.update(reconciliationResolution).set({ applyStatus: "failed", errorCode: input.errorCode,
    claimToken: null, claimExpiresAt: null, updatedAt: new Date() }).where(and(
    eq(reconciliationResolution.userId, input.userId), eq(reconciliationResolution.id, input.resolutionId),
    eq(reconciliationResolution.applyStatus, "processing"), eq(reconciliationResolution.claimToken, input.token),
  ));
  return updated.changes > 0;
}

/** Records an alias only after an explicit user decision; do not call from automatic matching. */
export async function rememberMerchantAlias(input: {
  userId: string;
  merchant: string;
  aliasMerchant: string;
}): Promise<void> {
  const [normalizedMerchant, normalizedAlias] = [normalizeAlias(input.merchant), normalizeAlias(input.aliasMerchant)].sort();
  if (!input.userId.trim() || !normalizedMerchant || !normalizedAlias) throw new Error("invalid_merchant_alias");
  const now = new Date();
  await db.insert(merchantAlias).values({
    id: randomUUID(), userId: input.userId, normalizedMerchant, normalizedAlias,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [merchantAlias.userId, merchantAlias.normalizedMerchant, merchantAlias.normalizedAlias],
    set: { updatedAt: now },
  });
}

function normalizeAlias(value: string): string { return normalizeReconciliationMerchant(value); }

function parseReasons(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("reconciliation_reasons_invalid");
  return value;
}

function validateResultInput(input: SaveReconciliationRunInput): void {
  const statements = new Set(input.statementResults.map((result) => result.statementTransactionId));
  const receipts = new Set(input.receiptResults.map((result) => result.receiptId));
  if (statements.size !== input.statementResults.length || receipts.size !== input.receiptResults.length) throw new Error("duplicate_reconciliation_result");
  for (const result of input.statementResults) {
    if (!isStatementStatus(result.status)) throw new Error("invalid_statement_result_status");
    if (result.status === "matched" && !result.matchedReceiptId) throw new Error("matched_receipt_required");
    if (result.matchedReceiptId && !receipts.has(result.matchedReceiptId)) throw new Error("matched_receipt_result_required");
    if (result.status !== "matched" && result.matchedReceiptId) throw new Error("unexpected_matched_receipt");
  }
  for (const result of input.receiptResults) {
    if (!isReceiptStatus(result.status)) throw new Error("invalid_receipt_result_status");
    if (result.status === "matched" && !result.matchedStatementTransactionId) throw new Error("matched_statement_required");
    if (result.matchedStatementTransactionId && !statements.has(result.matchedStatementTransactionId)) throw new Error("matched_statement_result_required");
    if (result.status !== "matched" && result.matchedStatementTransactionId) throw new Error("unexpected_matched_statement");
  }
  const receiptById = new Map(input.receiptResults.map((result) => [result.receiptId, result]));
  const statementById = new Map(input.statementResults.map((result) => [result.statementTransactionId, result]));
  for (const result of input.statementResults) {
    if (result.status !== "matched") continue;
    if (receiptById.get(result.matchedReceiptId!)?.matchedStatementTransactionId !== result.statementTransactionId) throw new Error("matched_pair_not_mutual");
  }
  for (const result of input.receiptResults) {
    if (result.status !== "matched") continue;
    if (statementById.get(result.matchedStatementTransactionId!)?.matchedReceiptId !== result.receiptId) throw new Error("matched_pair_not_mutual");
  }
  const perStatementRank = new Map<string, number>();
  for (const candidate of input.candidates) {
    if (!statements.has(candidate.statementTransactionId) || !receipts.has(candidate.receiptId)) throw new Error("candidate_result_required");
    if (!Number.isInteger(candidate.rank) || candidate.rank < 1 || candidate.rank > 3) throw new Error("invalid_candidate_rank");
    if (!Number.isFinite(candidate.score) || !Number.isFinite(candidate.merchantSimilarity)) throw new Error("invalid_candidate_score");
    const count = (perStatementRank.get(candidate.statementTransactionId) ?? 0) + 1;
    perStatementRank.set(candidate.statementTransactionId, count);
    if (count > 3) throw new Error("too_many_statement_candidates");
  }
}

function isStatementStatus(value: string): value is ReconciliationStatementResultInput["status"] {
  return value === "matched" || value === "needs_review" || value === "unmatched_statement";
}

function isReceiptStatus(value: string): value is ReconciliationReceiptResultInput["status"] {
  return value === "matched" || value === "needs_review" || value === "unmatched_receipt";
}
