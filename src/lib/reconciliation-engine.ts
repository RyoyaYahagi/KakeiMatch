/** Pure, deterministic reconciliation rules. Persistence and user scoping belong to callers. */

import { lexicographicMaximumAssignment } from "./assignment";

/**
 * 1.2.1 keeps every 1.2.0 automatic-match rule and candidate-set rule
 * unchanged. The only addition is review-candidate ordering (Issue #380 PR A),
 * which runs after automatic matching and never feeds back into it.
 */
export const RECONCILIATION_RULE_VERSION = "1.2.1";

export const RECONCILIATION_RULES = {
  candidateDateWindowDays: 7,
  autoMatchDateWindowDays: 2,
  amountToleranceAbsoluteYen: 100,
  amountToleranceRatio: 0.03,
  candidateMerchantSimilarity: 0.7,
  autoMatchMerchantSimilarity: 0.72,
  amountWeight: 0.55,
  dateWeight: 0.15,
  merchantWeight: 0.05,
  // At equal amounts, source evidence outweighs the full date/merchant variation.
  paymentSourceWeight: 0.25,
  autoMatchAmountWeight: 0.55,
  autoMatchDateWeight: 0.25,
  autoMatchMerchantWeight: 0.20,
  autoMatchScore: 0.88,
  autoMatchMargin: 0.15,
  candidatesPerStatement: 3,
} as const;

export type ReconciliationStatement = {
  statementTransactionId: string;
  provider: string;
  externalId: string | null;
  kind: "purchase" | "refund";
  usedDate: string;
  postedDate: string | null;
  merchant: string;
  amountYen: number;
  paymentMethod: string | null;
  /** Explicit account IDs supplied by the caller; never infer identity from account names. */
  preferredAccountIds?: readonly string[];
};

export type ReconciliationReceipt = {
  receiptId: string;
  actualTransactionId: string;
  merchant: string;
  purchasedDate: string;
  amountYen: number;
  actualAccountId: string;
};

export type ReconciliationStatus = "matched" | "needs_review" | "unmatched_statement" | "unmatched_receipt";

export type ReconciliationCandidate = {
  statementTransactionId: string;
  receiptId: string;
  rank: number;
  score: number;
  amountDeltaYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
  reasons: string[];
};

export type ReconciliationStatementResult = {
  statementTransactionId: string;
  status: "matched" | "needs_review" | "unmatched_statement";
  matchedReceiptId: string | null;
  reasonCodes: string[];
};

export type ReconciliationReceiptResult = {
  receiptId: string;
  status: "matched" | "needs_review" | "unmatched_receipt";
  matchedStatementTransactionId: string | null;
  reasonCodes: string[];
};

export type ReconciliationEngineResult = {
  ruleVersion: string;
  candidates: ReconciliationCandidate[];
  statementResults: ReconciliationStatementResult[];
  receiptResults: ReconciliationReceiptResult[];
};

const GENERAL_SEPARATOR = /[-‐‑‒–—―・,，.．/／\\:：;；|｜_＿()（）\[\]［］{}｛｝「」『』【】]+/gu;

/** Normalize only formatting; this intentionally does not infer merchant identity. */
export function normalizeReconciliationMerchant(merchant: string): string {
  // Collapse whitespace first, then remove it because spaces are not meaningful in store names.
  return merchant.normalize("NFKC").trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase()).replace(/[\p{Z}\s]+/gu, " ").replace(/[\p{Z}\s]+/gu, "").replace(GENERAL_SEPARATOR, "");
}

function bigrams(value: string): Set<string> {
  const chars = Array.from(value);
  const result = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) result.add(chars[i]! + chars[i + 1]!);
  return result;
}

/** Kana equivalence is a review-ranking hint, never automatic identity evidence. */
function normalizeCandidateMerchant(merchant: string): string {
  return normalizeReconciliationMerchant(merchant).replace(/[\u3041-\u3096\u309d\u309e]/gu,
    (kana) => String.fromCodePoint(kana.codePointAt(0)! + 0x60));
}

/** Sørensen–Dice similarity over character bigrams (0..1), stable for Japanese text. */
export function reconciliationMerchantSimilarity(left: string, right: string): number {
  const a = normalizeReconciliationMerchant(left);
  const b = normalizeReconciliationMerchant(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) return 0;
  let intersection = 0;
  for (const item of aBigrams) if (bBigrams.has(item)) intersection += 1;
  return (2 * intersection) / (aBigrams.size + bBigrams.size);
}

export function merchantAliasKey(left: string, right: string): string {
  const normalized = [normalizeReconciliationMerchant(left), normalizeReconciliationMerchant(right)].sort();
  return `${normalized[0]}\u0000${normalized[1]}`;
}

function utcDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return Math.floor(time / 86_400_000);
}

function safeAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= 0;
}

type InternalCandidate = ReconciliationCandidate & { aliasMatch: boolean; autoScore: number; autoMerchantSimilarity: number };

function scoreCandidate(input: {
  amountExact: boolean;
  amountDeltaYen: number;
  statementAmountYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
  autoMerchantSimilarity: number;
  aliasMatch: boolean;
  samePaymentSource: boolean;
}): { score: number; autoScore: number } {
  const amountTolerance = Math.max(
    RECONCILIATION_RULES.amountToleranceAbsoluteYen,
    input.statementAmountYen * RECONCILIATION_RULES.amountToleranceRatio,
  );
  const amountScore = input.amountExact ? 1 : Math.max(0, 1 - input.amountDeltaYen / amountTolerance);
  const dateScore = 1 - input.dateDistanceDays / (RECONCILIATION_RULES.candidateDateWindowDays + 1);
  const merchantScore = input.aliasMatch ? 1 : input.merchantSimilarity;
  const autoMerchantScore = input.aliasMatch ? 1 : input.autoMerchantSimilarity;
  const round = (score: number) => Math.round(score * 1_000_000) / 1_000_000;
  return {
    score: round(amountScore * RECONCILIATION_RULES.amountWeight + dateScore * RECONCILIATION_RULES.dateWeight
      + merchantScore * RECONCILIATION_RULES.merchantWeight + Number(input.samePaymentSource) * RECONCILIATION_RULES.paymentSourceWeight),
    // Keep automatic confidence conservative, independently of the review candidate ranking.
    autoScore: round(amountScore * RECONCILIATION_RULES.autoMatchAmountWeight
      + dateScore * RECONCILIATION_RULES.autoMatchDateWeight + autoMerchantScore * RECONCILIATION_RULES.autoMatchMerchantWeight),
  };
}

function margin(top: InternalCandidate | undefined, second: InternalCandidate | undefined): number {
  return top ? top.autoScore - (second?.autoScore ?? 0) : 0;
}

const utf8Encoder = new TextEncoder();

/** UTF-8 byte order, shared with the Swift assignment tie-break. */
function compareUtf8(left: string, right: string): number {
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Review scores already have six decimal places; keep assignment totals exact. */
function reviewAssignmentWeight(candidate: InternalCandidate): number {
  return Math.round(candidate.score * 1_000_000);
}

export type ReconciliationEngineInput = {
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases?: ReadonlySet<string>;
  excludedStatementIds?: ReadonlySet<string>;
  excludedReceiptIds?: ReadonlySet<string>;
  rejectedPairs?: ReadonlySet<string>;
  manualStatementIds?: ReadonlySet<string>;
};

type ReviewAssignment = Map<string, string>;

/**
 * Assign only the still-undecided statements to still-undecided receipts.
 * Both endpoints that automatic matching already decided are removed before
 * the assignment, and manual statement decisions are removed as well. Edges
 * are the existing review candidates, so this can never add a candidate or
 * reserve a receipt. The result is used only to choose the first review row.
 */
function computeReviewAssignment(
  statements: ReconciliationStatement[],
  allByStatement: Map<string, InternalCandidate[]>,
  matchedStatements: ReadonlyMap<string, string>,
  matchedReceipts: ReadonlyMap<string, string>,
  manualStatementIds: ReadonlySet<string> | undefined,
): ReviewAssignment {
  const rows = statements
    .filter((statement) => statement.kind === "purchase"
      && !matchedStatements.has(statement.statementTransactionId)
      && !manualStatementIds?.has(statement.statementTransactionId))
    .map((statement) => statement.statementTransactionId)
    .filter((statementId) => (allByStatement.get(statementId) ?? [])
      .some((candidate) => !matchedReceipts.has(candidate.receiptId)))
    .sort(compareUtf8);

  const columnIds = new Set<string>();
  for (const statementId of rows) {
    for (const candidate of allByStatement.get(statementId) ?? []) {
      if (!matchedReceipts.has(candidate.receiptId)) columnIds.add(candidate.receiptId);
    }
  }
  const columns = [...columnIds].sort(compareUtf8);
  const assignment: ReviewAssignment = new Map();
  if (rows.length === 0 || columns.length === 0) return assignment;

  const rowIndex = new Map(rows.map((id, index) => [id, index]));
  const columnIndex = new Map(columns.map((id, index) => [id, index]));
  const weights = rows.map(() => new Array<number>(columns.length).fill(0));
  for (const statementId of rows) {
    for (const candidate of allByStatement.get(statementId) ?? []) {
      if (matchedReceipts.has(candidate.receiptId)) continue;
      const column = columnIndex.get(candidate.receiptId);
      if (column === undefined) continue;
      weights[rowIndex.get(statementId)!]![column] = reviewAssignmentWeight(candidate);
    }
  }

  // Components share no rows or columns, so their lexicographic optima are
  // exactly the monolithic optimum. This keeps the Hungarian matrix small.
  const rowCount = rows.length;
  const columnCount = columns.length;
  const adjacency: number[][] = Array.from({ length: rowCount + columnCount }, () => []);
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      if ((weights[row]?.[column] ?? 0) <= 0) continue;
      adjacency[row]!.push(rowCount + column);
      adjacency[rowCount + column]!.push(row);
    }
  }

  const visited = new Array<boolean>(rowCount + columnCount).fill(false);
  for (let start = 0; start < rowCount + columnCount; start += 1) {
    if (visited[start] || adjacency[start]!.length === 0) continue;
    const componentRows: number[] = [];
    const componentColumns: number[] = [];
    const stack = [start];
    visited[start] = true;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node < rowCount) componentRows.push(node);
      else componentColumns.push(node - rowCount);
      for (const next of adjacency[node]!) {
        if (visited[next]) continue;
        visited[next] = true;
        stack.push(next);
      }
    }
    componentRows.sort((left, right) => left - right);
    componentColumns.sort((left, right) => left - right);
    if (componentRows.length === 0 || componentColumns.length === 0) continue;
    const localWeights = componentRows.map((row) => componentColumns.map((column) => weights[row]![column]!));
    const localAssignment = lexicographicMaximumAssignment(
      localWeights,
      componentRows.map((_, index) => index),
      componentColumns.map((_, index) => index),
    );
    for (let localRow = 0; localRow < componentRows.length; localRow += 1) {
      const localColumn = localAssignment[localRow] ?? -1;
      if (localColumn < 0) continue;
      const statementId = rows[componentRows[localRow]!]!;
      const receiptId = columns[componentColumns[localColumn]!]!;
      assignment.set(statementId, receiptId);
    }
  }
  return assignment;
}

export type ReconciliationRankingDiagnostics = {
  assignments: Array<{ statementTransactionId: string; receiptId: string }>;
};

/** Evaluation-only view of the review assignment. It never changes the result. */
export function inspectReconciliationRanking(input: ReconciliationEngineInput): ReconciliationRankingDiagnostics {
  const { reviewAssignment } = reconcile(input);
  return {
    assignments: [...reviewAssignment]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([statementTransactionId, receiptId]) => ({ statementTransactionId, receiptId })),
  };
}

function reconcile(input: ReconciliationEngineInput): { result: ReconciliationEngineResult; reviewAssignment: ReviewAssignment } {
  const statements = input.statements.filter((item) => !input.excludedStatementIds?.has(item.statementTransactionId)).sort((a, b) => a.statementTransactionId.localeCompare(b.statementTransactionId));
  const receipts = input.receipts.filter((item) => !input.excludedReceiptIds?.has(item.receiptId)).sort((a, b) => a.receiptId.localeCompare(b.receiptId));

  // Index receipts by UTC calendar day to avoid a statement × receipt Cartesian scan.
  const receiptBuckets = new Map<number, ReconciliationReceipt[]>();
  for (const receipt of receipts) {
    const day = utcDay(receipt.purchasedDate);
    if (day === null) continue;
    const bucket = receiptBuckets.get(day) ?? [];
    bucket.push(receipt);
    receiptBuckets.set(day, bucket);
  }

  const allByStatement = new Map<string, InternalCandidate[]>();
  const allByReceipt = new Map<string, InternalCandidate[]>();
  for (const statement of statements) {
    if (statement.kind !== "purchase") continue;
    const statementDay = utcDay(statement.usedDate);
    if (statementDay === null || !safeAmount(statement.amountYen)) continue;
    for (let offset = -RECONCILIATION_RULES.candidateDateWindowDays; offset <= RECONCILIATION_RULES.candidateDateWindowDays; offset += 1) {
      const dayReceipts = receiptBuckets.get(statementDay + offset);
      if (!dayReceipts) continue;
      for (const receipt of dayReceipts) {
        if (input.rejectedPairs?.has(`${statement.statementTransactionId}\0${receipt.receiptId}`)) continue;
        if (!safeAmount(receipt.amountYen)) continue;
        const receiptDay = utcDay(receipt.purchasedDate);
        if (receiptDay === null) continue;
        const dateDistanceDays = Math.abs(statementDay - receiptDay);
        const amountDeltaYen = Math.abs(statement.amountYen - receipt.amountYen);
        const amountExact = amountDeltaYen === 0;
        const autoMerchantSimilarity = reconciliationMerchantSimilarity(statement.merchant, receipt.merchant);
        const merchantSimilarity = reconciliationMerchantSimilarity(normalizeCandidateMerchant(statement.merchant), normalizeCandidateMerchant(receipt.merchant));
        const aliasMatch = input.aliases?.has(merchantAliasKey(statement.merchant, receipt.merchant)) ?? false;
        const allowedDelta = Math.max(RECONCILIATION_RULES.amountToleranceAbsoluteYen, statement.amountYen * RECONCILIATION_RULES.amountToleranceRatio);
        if (amountDeltaYen > allowedDelta) continue;
        const samePaymentSource = statement.preferredAccountIds?.includes(receipt.actualAccountId) ?? false;

        const reasons: string[] = [];
        if (amountExact) reasons.push("amount_exact");
        else reasons.push("amount_close");
        if (dateDistanceDays <= RECONCILIATION_RULES.autoMatchDateWindowDays) reasons.push("date_close");
        else reasons.push("date_within_window");
        if (merchantSimilarity >= RECONCILIATION_RULES.candidateMerchantSimilarity) reasons.push("merchant_similar");
        if (aliasMatch) reasons.push("merchant_alias_match");
        if (samePaymentSource) reasons.push("payment_source_match");
        const candidate: InternalCandidate = {
          statementTransactionId: statement.statementTransactionId,
          receiptId: receipt.receiptId,
          rank: 0,
          ...scoreCandidate({ amountExact, amountDeltaYen, statementAmountYen: statement.amountYen, dateDistanceDays, merchantSimilarity, autoMerchantSimilarity, aliasMatch, samePaymentSource }),
          amountDeltaYen,
          dateDistanceDays,
          merchantSimilarity,
          autoMerchantSimilarity,
          reasons,
          aliasMatch,
        };
        const statementCandidates = allByStatement.get(statement.statementTransactionId) ?? [];
        statementCandidates.push(candidate);
        allByStatement.set(statement.statementTransactionId, statementCandidates);
        const receiptCandidates = allByReceipt.get(receipt.receiptId) ?? [];
        receiptCandidates.push(candidate);
        allByReceipt.set(receipt.receiptId, receiptCandidates);
      }
    }
  }

  const compareCandidates = (a: InternalCandidate, b: InternalCandidate) => b.autoScore - a.autoScore || a.statementTransactionId.localeCompare(b.statementTransactionId) || a.receiptId.localeCompare(b.receiptId);
  for (const list of allByStatement.values()) list.sort(compareCandidates);
  for (const list of allByReceipt.values()) list.sort(compareCandidates);

  const matchedStatements = new Map<string, string>();
  const matchedReceipts = new Map<string, string>();
  for (const statement of statements) {
    const choices = allByStatement.get(statement.statementTransactionId) ?? [];
    const top = choices[0];
    if (!top || input.manualStatementIds?.has(statement.statementTransactionId)) continue;
    const receiptChoices = allByReceipt.get(top.receiptId) ?? [];
    const receiptTop = receiptChoices[0];
    const isMutualBest = receiptTop?.statementTransactionId === statement.statementTransactionId;
    const statementHasMargin = margin(top, choices[1]) >= RECONCILIATION_RULES.autoMatchMargin;
    const receiptHasMargin = margin(receiptTop, receiptChoices[1]) >= RECONCILIATION_RULES.autoMatchMargin;
    const isExactAndStrong = top.amountDeltaYen === 0
      && top.dateDistanceDays <= RECONCILIATION_RULES.autoMatchDateWindowDays
      && (top.autoMerchantSimilarity >= RECONCILIATION_RULES.autoMatchMerchantSimilarity || top.aliasMatch)
      && top.autoScore >= RECONCILIATION_RULES.autoMatchScore;
    if (isMutualBest && statementHasMargin && receiptHasMargin && isExactAndStrong) {
      matchedStatements.set(statement.statementTransactionId, top.receiptId);
      matchedReceipts.set(top.receiptId, statement.statementTransactionId);
    }
  }

  const ambiguous = (candidate: InternalCandidate): boolean => {
    const s = allByStatement.get(candidate.statementTransactionId) ?? [];
    const r = allByReceipt.get(candidate.receiptId) ?? [];
    const st = s[0];
    const rt = r[0];
    return margin(st, s[1]) < RECONCILIATION_RULES.autoMatchMargin
      || margin(rt, r[1]) < RECONCILIATION_RULES.autoMatchMargin
      || st?.receiptId !== candidate.receiptId
      || rt?.statementTransactionId !== candidate.statementTransactionId;
  };

  // Ranking runs strictly after automatic matching. It receives the automatic
  // pairs as fixed endpoints and cannot change a matched/unmatched status.
  const reviewAssignment = computeReviewAssignment(statements, allByStatement, matchedStatements, matchedReceipts, input.manualStatementIds);

  const candidates: ReconciliationCandidate[] = [];
  for (const statement of statements) {
    const choices = allByStatement.get(statement.statementTransactionId) ?? [];
    const matchedReceiptId = matchedStatements.get(statement.statementTransactionId);
    const assignedReceiptId = reviewAssignment.get(statement.statementTransactionId);
    const preferredReceiptId = matchedReceiptId ?? assignedReceiptId;
    // Retain the automatic pair first. For a still-undecided statement, the
    // global assignment's partner is promoted only when it is an existing
    // candidate; no new pair is added and no receipt is reserved.
    [...choices].sort((a, b) => Number(b.receiptId === preferredReceiptId) - Number(a.receiptId === preferredReceiptId)
      || b.score - a.score || compareCandidates(a, b)).slice(0, RECONCILIATION_RULES.candidatesPerStatement).forEach((candidate, index) => {
      candidates.push({
        statementTransactionId: candidate.statementTransactionId,
        receiptId: candidate.receiptId,
        rank: index + 1,
        score: candidate.score,
        amountDeltaYen: candidate.amountDeltaYen,
        dateDistanceDays: candidate.dateDistanceDays,
        merchantSimilarity: candidate.merchantSimilarity,
        reasons: ambiguous(candidate) ? [...candidate.reasons, "ambiguous_candidates"] : candidate.reasons,
      });
    });
  }

  const statementResults: ReconciliationStatementResult[] = statements.map((statement) => {
    if (statement.kind === "refund") return { statementTransactionId: statement.statementTransactionId, status: "unmatched_statement", matchedReceiptId: null, reasonCodes: ["refund_not_supported"] };
    const receiptId = matchedStatements.get(statement.statementTransactionId);
    if (receiptId) return { statementTransactionId: statement.statementTransactionId, status: "matched", matchedReceiptId: receiptId, reasonCodes: ["automatic_high_confidence_match"] };
    const hasCandidate = (allByStatement.get(statement.statementTransactionId)?.length ?? 0) > 0;
    const hasAmbiguity = (allByStatement.get(statement.statementTransactionId) ?? []).some(ambiguous);
    return { statementTransactionId: statement.statementTransactionId, status: hasCandidate ? "needs_review" : "unmatched_statement", matchedReceiptId: null,
      reasonCodes: hasCandidate ? ["candidate_requires_review", ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });
  const receiptResults: ReconciliationReceiptResult[] = receipts.map((receipt) => {
    const statementTransactionId = matchedReceipts.get(receipt.receiptId);
    if (statementTransactionId) return { receiptId: receipt.receiptId, status: "matched", matchedStatementTransactionId: statementTransactionId, reasonCodes: ["automatic_high_confidence_match"] };
    const hasCandidate = (allByReceipt.get(receipt.receiptId)?.length ?? 0) > 0;
    const hasAmbiguity = (allByReceipt.get(receipt.receiptId) ?? []).some(ambiguous);
    return { receiptId: receipt.receiptId, status: hasCandidate ? "needs_review" : "unmatched_receipt", matchedStatementTransactionId: null, reasonCodes: hasCandidate ? ["candidate_requires_review", ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });

  return {
    result: { ruleVersion: RECONCILIATION_RULE_VERSION, candidates, statementResults, receiptResults },
    reviewAssignment,
  };
}

export function runReconciliationEngine(input: ReconciliationEngineInput): ReconciliationEngineResult {
  return reconcile(input).result;
}
