/** Pure, deterministic reconciliation rules. Persistence and user scoping belong to callers. */

export const RECONCILIATION_RULE_VERSION = "1.0.0";

export const RECONCILIATION_RULES = {
  candidateDateWindowDays: 7,
  autoMatchDateWindowDays: 2,
  amountToleranceAbsoluteYen: 100,
  amountToleranceRatio: 0.03,
  candidateMerchantSimilarity: 0.7,
  autoMatchMerchantSimilarity: 0.72,
  amountWeight: 0.55,
  dateWeight: 0.25,
  merchantWeight: 0.2,
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

type InternalCandidate = ReconciliationCandidate & { aliasMatch: boolean };

function scoreCandidate(input: {
  amountExact: boolean;
  amountDeltaYen: number;
  statementAmountYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
  aliasMatch: boolean;
}): number {
  const amountTolerance = Math.max(
    RECONCILIATION_RULES.amountToleranceAbsoluteYen,
    input.statementAmountYen * RECONCILIATION_RULES.amountToleranceRatio,
  );
  const amountScore = input.amountExact ? 1 : Math.max(0, 1 - input.amountDeltaYen / amountTolerance);
  const dateScore = 1 - input.dateDistanceDays / (RECONCILIATION_RULES.candidateDateWindowDays + 1);
  const merchantScore = input.aliasMatch ? 1 : input.merchantSimilarity;
  return Math.round((amountScore * RECONCILIATION_RULES.amountWeight + dateScore * RECONCILIATION_RULES.dateWeight + merchantScore * RECONCILIATION_RULES.merchantWeight) * 1_000_000) / 1_000_000;
}

function margin(top: InternalCandidate | undefined, second: InternalCandidate | undefined): number {
  return top ? top.score - (second?.score ?? 0) : 0;
}

export function runReconciliationEngine(input: {
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases?: ReadonlySet<string>;
  excludedStatementIds?: ReadonlySet<string>;
  excludedReceiptIds?: ReadonlySet<string>;
  rejectedPairs?: ReadonlySet<string>;
}): ReconciliationEngineResult {
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
        const merchantSimilarity = reconciliationMerchantSimilarity(statement.merchant, receipt.merchant);
        const aliasMatch = input.aliases?.has(merchantAliasKey(statement.merchant, receipt.merchant)) ?? false;
        const allowedDelta = Math.max(RECONCILIATION_RULES.amountToleranceAbsoluteYen, statement.amountYen * RECONCILIATION_RULES.amountToleranceRatio);
        if (!amountExact && (amountDeltaYen > allowedDelta || (merchantSimilarity < RECONCILIATION_RULES.candidateMerchantSimilarity && !aliasMatch))) continue;

        const reasons: string[] = [];
        if (amountExact) reasons.push("amount_exact");
        else reasons.push("amount_close");
        if (dateDistanceDays <= RECONCILIATION_RULES.autoMatchDateWindowDays) reasons.push("date_close");
        else reasons.push("date_within_window");
        if (merchantSimilarity >= RECONCILIATION_RULES.candidateMerchantSimilarity) reasons.push("merchant_similar");
        if (aliasMatch) reasons.push("merchant_alias_match");
        const candidate: InternalCandidate = {
          statementTransactionId: statement.statementTransactionId,
          receiptId: receipt.receiptId,
          rank: 0,
          score: scoreCandidate({ amountExact, amountDeltaYen, statementAmountYen: statement.amountYen, dateDistanceDays, merchantSimilarity, aliasMatch }),
          amountDeltaYen,
          dateDistanceDays,
          merchantSimilarity,
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

  const compareCandidates = (a: InternalCandidate, b: InternalCandidate) => b.score - a.score || a.statementTransactionId.localeCompare(b.statementTransactionId) || a.receiptId.localeCompare(b.receiptId);
  for (const list of allByStatement.values()) list.sort(compareCandidates);
  for (const list of allByReceipt.values()) list.sort(compareCandidates);

  const matchedStatements = new Map<string, string>();
  const matchedReceipts = new Map<string, string>();
  for (const statement of statements) {
    const choices = allByStatement.get(statement.statementTransactionId) ?? [];
    const top = choices[0];
    if (!top) continue;
    const receiptChoices = allByReceipt.get(top.receiptId) ?? [];
    const receiptTop = receiptChoices[0];
    const isMutualBest = receiptTop?.statementTransactionId === statement.statementTransactionId;
    const statementHasMargin = margin(top, choices[1]) >= RECONCILIATION_RULES.autoMatchMargin;
    const receiptHasMargin = margin(receiptTop, receiptChoices[1]) >= RECONCILIATION_RULES.autoMatchMargin;
    const isExactAndStrong = top.amountDeltaYen === 0
      && top.dateDistanceDays <= RECONCILIATION_RULES.autoMatchDateWindowDays
      && (top.merchantSimilarity >= RECONCILIATION_RULES.autoMatchMerchantSimilarity || top.aliasMatch)
      && top.score >= RECONCILIATION_RULES.autoMatchScore;
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

  const candidates: ReconciliationCandidate[] = [];
  for (const statement of statements) {
    const choices = allByStatement.get(statement.statementTransactionId) ?? [];
    choices.slice(0, RECONCILIATION_RULES.candidatesPerStatement).forEach((candidate, index) => {
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
    return { statementTransactionId: statement.statementTransactionId, status: hasCandidate ? "needs_review" : "unmatched_statement", matchedReceiptId: null, reasonCodes: hasCandidate ? ["candidate_requires_review", ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });
  const receiptResults: ReconciliationReceiptResult[] = receipts.map((receipt) => {
    const statementTransactionId = matchedReceipts.get(receipt.receiptId);
    if (statementTransactionId) return { receiptId: receipt.receiptId, status: "matched", matchedStatementTransactionId: statementTransactionId, reasonCodes: ["automatic_high_confidence_match"] };
    const hasCandidate = (allByReceipt.get(receipt.receiptId)?.length ?? 0) > 0;
    const hasAmbiguity = (allByReceipt.get(receipt.receiptId) ?? []).some(ambiguous);
    return { receiptId: receipt.receiptId, status: hasCandidate ? "needs_review" : "unmatched_receipt", matchedStatementTransactionId: null, reasonCodes: hasCandidate ? ["candidate_requires_review", ...(hasAmbiguity ? ["ambiguous_candidates"] : [])] : ["no_candidate"] };
  });

  return { ruleVersion: RECONCILIATION_RULE_VERSION, candidates, statementResults, receiptResults };
}
