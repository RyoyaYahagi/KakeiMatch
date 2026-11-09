/** Pure, deterministic reconciliation rules. Persistence and user scoping belong to callers. */

import { lexicographicMaximumAssignment, maximumWeight } from "./assignment";

export const RECONCILIATION_RULE_VERSION = "1.3.0";

/** Reason code shared by the review pair selected by the global assignment. */
export const GLOBAL_ASSIGNMENT_REASON = "global_assignment_pair";

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
  // Global assignment uses integer weights so equal totals are exact.
  globalAssignmentWeightScale: 1_000_000,
  globalAssignmentMargin: 0.15,
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

/** UTF-8 byte order, used only by the assignment tie-break and its fixtures. */
function compareUtf8(left: string, right: string): number {
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** True only for an existing candidate that already satisfies every hard condition. */
function isGlobalAssignmentEligible(candidate: InternalCandidate): boolean {
  return candidate.amountDeltaYen === 0
    && candidate.dateDistanceDays <= RECONCILIATION_RULES.autoMatchDateWindowDays
    && (candidate.autoMerchantSimilarity >= RECONCILIATION_RULES.autoMatchMerchantSimilarity || candidate.aliasMatch)
    && candidate.autoScore >= RECONCILIATION_RULES.autoMatchScore;
}

function globalAssignmentWeight(candidate: InternalCandidate): number {
  return Math.floor(RECONCILIATION_RULES.globalAssignmentWeightScale * candidate.autoScore + 0.5);
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

type PreparedReconciliation = {
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  allByStatement: Map<string, InternalCandidate[]>;
  allByReceipt: Map<string, InternalCandidate[]>;
  compareCandidates: (a: InternalCandidate, b: InternalCandidate) => number;
  ambiguous: (candidate: InternalCandidate) => boolean;
};

function prepareReconciliation(input: ReconciliationEngineInput): PreparedReconciliation {
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

  return { statements, receipts, allByStatement, allByReceipt, compareCandidates, ambiguous };
}

export type ReconciliationAssignmentDiagnostics = {
  optimumWeight: number;
  assignment: Array<{ statementTransactionId: string; receiptId: string }>;
  deltas: Array<{ statementTransactionId: string; receiptId: string; delta: number; automatic: boolean }>;
};

type GlobalAssignment = ReconciliationAssignmentDiagnostics & {
  assignedStatements: Map<string, InternalCandidate>;
  assignedReceipts: Map<string, InternalCandidate>;
  matchedStatements: Map<string, string>;
  matchedReceipts: Map<string, string>;
};

function computeGlobalAssignment(
  statements: ReconciliationStatement[],
  allByStatement: Map<string, InternalCandidate[]>,
  manualStatementIds: ReadonlySet<string> | undefined,
): GlobalAssignment {
  // Candidate edges E are the existing candidates that already satisfy every hard
  // automatic-match condition. The global assignment never widens this set.
  const assignmentCandidates = new Map<string, InternalCandidate[]>();
  const assignmentReceiptIds = new Set<string>();
  for (const statement of statements) {
    if (statement.kind !== "purchase" || manualStatementIds?.has(statement.statementTransactionId)) continue;
    const eligible = (allByStatement.get(statement.statementTransactionId) ?? []).filter(isGlobalAssignmentEligible);
    if (eligible.length === 0) continue;
    assignmentCandidates.set(statement.statementTransactionId, eligible);
    for (const candidate of eligible) assignmentReceiptIds.add(candidate.receiptId);
  }
  const assignmentRowOrder = [...assignmentCandidates.keys()].sort(compareUtf8);
  const assignmentReceiptOrder = [...assignmentReceiptIds].sort(compareUtf8);
  const assignmentReceiptIndex = new Map(assignmentReceiptOrder.map((id, index) => [id, index]));
  const assignmentRowIndex = new Map(assignmentRowOrder.map((id, index) => [id, index]));
  const assignmentWeights = assignmentRowOrder.map((statementId) => {
    const row = new Array<number>(assignmentReceiptOrder.length).fill(0);
    for (const candidate of assignmentCandidates.get(statementId) ?? []) {
      row[assignmentReceiptIndex.get(candidate.receiptId)!] = globalAssignmentWeight(candidate);
    }
    return row;
  });

  // Assignment, Δ and the lexicographic tie-break are separable over the
  // connected components of E. Components share neither rows nor columns, so
  // summing their optima is exactly the monolithic optimum while keeping each
  // Hungarian matrix small.
  type AssignmentNode = { kind: "statement" | "receipt"; id: string };
  const nodes = new Map<string, AssignmentNode>();
  const adjacency = new Map<string, string[]>();
  const nodeKey = (kind: AssignmentNode["kind"], id: string): string => `${kind}\u0000${id}`;
  const connect = (left: string, right: string): void => {
    const leftEdges = adjacency.get(left) ?? [];
    leftEdges.push(right);
    adjacency.set(left, leftEdges);
    const rightEdges = adjacency.get(right) ?? [];
    rightEdges.push(left);
    adjacency.set(right, rightEdges);
  };
  for (let row = 0; row < assignmentRowOrder.length; row += 1) {
    for (let column = 0; column < assignmentReceiptOrder.length; column += 1) {
      if ((assignmentWeights[row]?.[column] ?? 0) <= 0) continue;
      const statementNode = nodeKey("statement", assignmentRowOrder[row]!);
      const receiptNode = nodeKey("receipt", assignmentReceiptOrder[column]!);
      nodes.set(statementNode, { kind: "statement", id: assignmentRowOrder[row]! });
      nodes.set(receiptNode, { kind: "receipt", id: assignmentReceiptOrder[column]! });
      connect(statementNode, receiptNode);
    }
  }

  const visited = new Set<string>();
  const components: Array<{ rows: number[]; columns: number[] }> = [];
  const visit = (start: string): void => {
    if (visited.has(start)) return;
    visited.add(start);
    const rows: number[] = [];
    const columns: number[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const key = stack.pop()!;
      const node = nodes.get(key)!;
      if (node.kind === "statement") rows.push(assignmentRowIndex.get(node.id)!);
      else columns.push(assignmentReceiptIndex.get(node.id)!);
      for (const next of adjacency.get(key) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    rows.sort((left, right) => left - right);
    columns.sort((left, right) => left - right);
    components.push({ rows, columns });
  };
  for (const statementId of assignmentRowOrder) visit(nodeKey("statement", statementId));
  for (const receiptId of assignmentReceiptOrder) visit(nodeKey("receipt", receiptId));

  const assignedStatements = new Map<string, InternalCandidate>();
  const assignedReceipts = new Map<string, InternalCandidate>();
  const deltaByPair = new Map<string, ReconciliationAssignmentDiagnostics["deltas"][number]>();
  let optimumWeight = 0;
  const globalAssignmentThreshold = Math.round(RECONCILIATION_RULES.globalAssignmentMargin * RECONCILIATION_RULES.globalAssignmentWeightScale);

  for (const component of components) {
    if (component.rows.length === 0 || component.columns.length === 0) continue;
    const localWeights = component.rows.map((row) => component.columns.map((column) => assignmentWeights[row]![column]!));
    const componentOptimum = maximumWeight(localWeights);
    optimumWeight += componentOptimum;
    const localAssignment = lexicographicMaximumAssignment(
      localWeights,
      component.rows.map((_, index) => index),
      component.columns.map((_, index) => index),
    );

    // Δe is evaluated independently against the original E. Removing only e and
    // re-optimizing inside its component keeps every other edge available, so
    // an equal-total alternative produces Δe = 0.
    for (let localRow = 0; localRow < component.rows.length; localRow += 1) {
      const localColumn = localAssignment[localRow] ?? -1;
      if (localColumn < 0 || (localWeights[localRow]?.[localColumn] ?? 0) <= 0) continue;
      const statementId = assignmentRowOrder[component.rows[localRow]!]!;
      const receiptId = assignmentReceiptOrder[component.columns[localColumn]!]!;
      const candidate = (assignmentCandidates.get(statementId) ?? []).find((item) => item.receiptId === receiptId);
      if (!candidate) throw new Error("global_assignment_edge_missing");
      assignedStatements.set(statementId, candidate);
      assignedReceipts.set(receiptId, candidate);

      const original = localWeights[localRow]![localColumn]!;
      localWeights[localRow]![localColumn] = 0;
      const withoutEdge = maximumWeight(localWeights);
      localWeights[localRow]![localColumn] = original;
      const delta = componentOptimum - withoutEdge;
      deltaByPair.set(`${statementId}\u0000${receiptId}`, {
        statementTransactionId: statementId, receiptId, delta, automatic: delta >= globalAssignmentThreshold,
      });
    }
  }

  const assignment: ReconciliationAssignmentDiagnostics["assignment"] = [];
  const deltas: ReconciliationAssignmentDiagnostics["deltas"] = [];
  const matchedStatements = new Map<string, string>();
  const matchedReceipts = new Map<string, string>();
  for (const statementId of assignmentRowOrder) {
    const candidate = assignedStatements.get(statementId);
    if (!candidate) continue;
    assignment.push({ statementTransactionId: statementId, receiptId: candidate.receiptId });
    const delta = deltaByPair.get(`${statementId}\u0000${candidate.receiptId}`)!;
    deltas.push(delta);
    if (!delta.automatic) continue;
    matchedStatements.set(statementId, candidate.receiptId);
    matchedReceipts.set(candidate.receiptId, statementId);
  }
  return { optimumWeight, assignment, deltas, assignedStatements, assignedReceipts, matchedStatements, matchedReceipts };
}

/** Evaluation-only view of E, M*, Δe and the automatic decisions. */
export function inspectReconciliationAssignment(input: ReconciliationEngineInput): ReconciliationAssignmentDiagnostics {
  const prepared = prepareReconciliation(input);
  const global = computeGlobalAssignment(prepared.statements, prepared.allByStatement, input.manualStatementIds);
  return { optimumWeight: global.optimumWeight, assignment: global.assignment, deltas: global.deltas };
}

export function runReconciliationEngine(input: ReconciliationEngineInput): ReconciliationEngineResult {
  const prepared = prepareReconciliation(input);
  const { statements, receipts, allByStatement, allByReceipt, compareCandidates, ambiguous } = prepared;
  const globalAssignment = computeGlobalAssignment(statements, allByStatement, input.manualStatementIds);
  const { assignedStatements, assignedReceipts, matchedStatements, matchedReceipts } = globalAssignment;

  const candidates: ReconciliationCandidate[] = [];
  for (const statement of statements) {
    const choices = allByStatement.get(statement.statementTransactionId) ?? [];
    const matchedReceiptId = matchedStatements.get(statement.statementTransactionId);
    const assignedReceiptId = assignedStatements.get(statement.statementTransactionId)?.receiptId;
    const preferredReceiptId = matchedReceiptId ?? assignedReceiptId;
    // Retain the automatic or globally assigned pair even when review ranking
    // favors a different source; the remaining slots stay in review score order.
    [...choices].sort((a, b) => Number(b.receiptId === preferredReceiptId) - Number(a.receiptId === preferredReceiptId)
      || b.score - a.score || compareCandidates(a, b)).slice(0, RECONCILIATION_RULES.candidatesPerStatement).forEach((candidate, index) => {
      const reasons = assignedReceiptId && !matchedReceiptId && candidate.receiptId === assignedReceiptId
        ? [...candidate.reasons, GLOBAL_ASSIGNMENT_REASON]
        : candidate.reasons;
      candidates.push({
        statementTransactionId: candidate.statementTransactionId,
        receiptId: candidate.receiptId,
        rank: index + 1,
        score: candidate.score,
        amountDeltaYen: candidate.amountDeltaYen,
        dateDistanceDays: candidate.dateDistanceDays,
        merchantSimilarity: candidate.merchantSimilarity,
        reasons: !matchedReceiptId && ambiguous(candidate) ? [...reasons, "ambiguous_candidates"] : reasons,
      });
    });
  }

  const statementResults: ReconciliationStatementResult[] = statements.map((statement) => {
    if (statement.kind === "refund") return { statementTransactionId: statement.statementTransactionId, status: "unmatched_statement", matchedReceiptId: null, reasonCodes: ["refund_not_supported"] };
    const receiptId = matchedStatements.get(statement.statementTransactionId);
    if (receiptId) return { statementTransactionId: statement.statementTransactionId, status: "matched", matchedReceiptId: receiptId, reasonCodes: ["automatic_high_confidence_match"] };
    const hasCandidate = (allByStatement.get(statement.statementTransactionId)?.length ?? 0) > 0;
    const hasAmbiguity = (allByStatement.get(statement.statementTransactionId) ?? []).some(ambiguous);
    const assigned = assignedStatements.has(statement.statementTransactionId);
    return { statementTransactionId: statement.statementTransactionId, status: hasCandidate ? "needs_review" : "unmatched_statement", matchedReceiptId: null,
      reasonCodes: hasCandidate ? ["candidate_requires_review", ...(assigned ? [GLOBAL_ASSIGNMENT_REASON] : []), ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });
  const receiptResults: ReconciliationReceiptResult[] = receipts.map((receipt) => {
    const statementTransactionId = matchedReceipts.get(receipt.receiptId);
    if (statementTransactionId) return { receiptId: receipt.receiptId, status: "matched", matchedStatementTransactionId: statementTransactionId, reasonCodes: ["automatic_high_confidence_match"] };
    const hasCandidate = (allByReceipt.get(receipt.receiptId)?.length ?? 0) > 0;
    const hasAmbiguity = (allByReceipt.get(receipt.receiptId) ?? []).some(ambiguous);
    const assigned = assignedReceipts.has(receipt.receiptId);
    return { receiptId: receipt.receiptId, status: hasCandidate ? "needs_review" : "unmatched_receipt", matchedStatementTransactionId: null, reasonCodes: hasCandidate ? ["candidate_requires_review", ...(assigned ? [GLOBAL_ASSIGNMENT_REASON] : []), ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });

  return { ruleVersion: RECONCILIATION_RULE_VERSION, candidates, statementResults, receiptResults };
}
