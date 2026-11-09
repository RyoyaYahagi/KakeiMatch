/**
 * Property-based evaluation for the reconciliation engine.
 *
 * Generates seeded ledgers and statements with known ground-truth pairs, then
 * checks safety invariants over many cases: no false automatic match, no double
 * match, no refund match, deterministic output, and rule-contract stability.
 *
 * Run with:
 *   node --conditions=react-server --import tsx eval/run-reconciliation-property.ts
 */

import {
  RECONCILIATION_RULES,
  RECONCILIATION_RULE_VERSION,
  reconciliationMerchantSimilarity,
  runReconciliationEngine,
  type ReconciliationCandidate,
  type ReconciliationEngineResult,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";

const DAY = 86_400_000;
const DEFAULT_CASES = 1_200;
const DEFAULT_SEED = 376;
const PINNED_RULE_VERSION = "1.2.0";
const PINNED_RULES = {
  candidateDateWindowDays: 7,
  autoMatchDateWindowDays: 2,
  amountToleranceAbsoluteYen: 100,
  amountToleranceRatio: 0.03,
  autoMatchMerchantSimilarity: 0.72,
  autoMatchScore: 0.88,
  autoMatchMargin: 0.15,
} as const;

type Family = "clean" | "noise" | "near-miss" | "twin" | "irreducible";
type TruthClass = "separable" | "ambiguous" | "unrecoverable";

const FAMILIES: readonly Family[] = ["clean", "noise", "near-miss", "twin", "irreducible"];

type TruthPair = {
  statementId: string;
  receiptId: string;
  /** Class the generator intended to construct. */
  intent: TruthClass;
  /** Class recomputed from the generated records before assertions. */
  observedClass: TruthClass;
};

type GeneratedCase = {
  id: string;
  seed: number;
  family: Family;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  truthPairs: TruthPair[];
  refundStatementIds: Set<string>;
};

type Options = {
  cases: number;
  seed: number;
  family: Family | null;
  maxViolations: number;
};

type Violation = {
  seed: number;
  caseId: string;
  family: Family;
  kind: string;
  detail: string;
};

type IndistinguishableMatch = {
  seed: number;
  caseId: string;
  family: Family;
  statementId: string;
  matchedReceiptId: string;
  truthReceiptId: string;
  matchedAmountDeltaYen: number;
  truthAmountDeltaYen: number;
  matchedDateDistanceDays: number;
  truthDateDistanceDays: number;
  matchedMerchantSimilarity: number;
  truthMerchantSimilarity: number;
};

type CaseMetrics = {
  caseCount: number;
  statementCount: number;
  receiptCount: number;
  truthPairCount: number;
  separableTruthPairCount: number;
  ambiguousTruthPairCount: number;
  unrecoverableTruthPairCount: number;
  autoMatchCount: number;
  correctAutoMatchCount: number;
  falseAutoMatchCount: number;
  indistinguishableAutoMatchCount: number;
  ambiguousAutoMatchCount: number;
  ineligibleTruthAutoMatchCount: number;
  unexplainedAutoMatchCount: number;
  matchWithoutTruthCount: number;
  doubleMatchCount: number;
  refundMatchCount: number;
  nondeterminismCount: number;
  classificationMismatchCount: number;
  candidateChecks: number;
  candidateHits: number;
  truthPairsWithoutCandidates: number;
  ambiguousAbstentionCount: number;
  unrecoverableAbstentionCount: number;
};

type FinalMetrics = CaseMetrics & {
  autoMatchPrecision: number;
  autoMatchPrecisionAll: number;
  autoMatchCoverage: number;
  separableCoverage: number | null;
  candidateRecallAt3: number | null;
  ambiguousAbstentionRate: number | null;
  unrecoverableAbstentionRate: number | null;
};

type CaseOutcome = {
  generated: GeneratedCase;
  metrics: CaseMetrics;
  violations: Violation[];
  indistinguishable: IndistinguishableMatch[];
};

// ---------- seeded RNG (mulberry32) ----------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  if (values.length === 0) throw new Error("generator: cannot pick from an empty list");
  return values[Math.floor(rng() * values.length)]!;
}

function int(rng: () => number, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

function shuffle<T>(rng: () => number, values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ---------- dates and amounts ----------

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / DAY);
}

function formatDay(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function normalDateJitter(rng: () => number): number {
  const roll = rng();
  if (roll < 0.7) return 0;
  if (roll < 0.9) return pick(rng, [-1, 1]);
  return pick(rng, [-2, 2]);
}

function reviewOnlyDateJitter(rng: () => number): number {
  return pick(rng, [3, 4, 5, 6, 7]) * (rng() < 0.5 ? -1 : 1);
}

// ---------- merchant pool ----------

type MerchantPair = {
  statement: string;
  receipt: string;
  similarity: number;
};

const MERCHANT_FAMILIES: ReadonlyArray<{ base: string; variants: readonly string[] }> = [
  { base: "セブンイレブン", variants: ["セブンイレブン", "セブン-イレブン", "セブンイレブン新宿店", "ｾﾌﾞﾝｲﾚﾌﾞﾝ"] },
  { base: "アオゾラストア", variants: ["アオゾラストア", "アオゾラストア新宿店", "ｱｵｿﾞﾗｽﾄｱ"] },
  { base: "アオゾラカフェ", variants: ["アオゾラカフェ", "アオゾラカフェ新宿店"] },
  { base: "アオゾラ薬局", variants: ["アオゾラ薬局", "アオゾラ薬局新宿店"] },
  { base: "ファミリーマート", variants: ["ファミリーマート", "ファミリーマート新宿店", "ﾌｧﾐﾘｰﾏｰﾄ", "ファミリ-マート"] },
  { base: "Amazon", variants: ["Amazon", "AMAZON", "amazon", "Amazon.co.jp"] },
  { base: "イオン", variants: ["イオン", "イオン新宿店", "AEON", "ｲｵﾝ"] },
  { base: "マツモトキヨシ", variants: ["マツモトキヨシ", "マツモトキヨシ新宿店", "ﾏﾂﾓﾄｷﾖｼ", "マツキヨ"] },
  { base: "楽天市場", variants: ["楽天市場", "楽天市場 新宿", "RAKUTEN"] },
  { base: "ローソン", variants: ["ローソン", "ローソン新宿店", "LAWSON", "ﾛｰｿﾝ"] },
];

type MerchantPairs = {
  exact: MerchantPair[];
  format: MerchantPair[];
  moderate: MerchantPair[];
  low: MerchantPair[];
  competitor: MerchantPair[];
  allNames: string[];
};

function buildMerchantPairs(): MerchantPairs {
  const exact: MerchantPair[] = [];
  const format: MerchantPair[] = [];
  const moderate: MerchantPair[] = [];
  const low: MerchantPair[] = [];
  const competitor: MerchantPair[] = [];
  const allNames = new Set<string>();
  for (const family of MERCHANT_FAMILIES) {
    for (const name of family.variants) allNames.add(name);
    for (const statement of family.variants) {
      for (const receipt of family.variants) {
        const similarity = reconciliationMerchantSimilarity(statement, receipt);
        const pair = { statement, receipt, similarity };
        if (statement === receipt) exact.push(pair);
        else if (similarity >= 0.999) format.push(pair);
        else if (similarity >= PINNED_RULES.autoMatchMerchantSimilarity) moderate.push(pair);
        else low.push(pair);
      }
    }
  }
  for (const left of MERCHANT_FAMILIES) {
    for (const right of MERCHANT_FAMILIES) {
      if (left === right) continue;
      for (const statement of left.variants) {
        for (const receipt of right.variants) {
          const similarity = reconciliationMerchantSimilarity(statement, receipt);
          if (similarity < PINNED_RULES.autoMatchMerchantSimilarity) competitor.push({ statement, receipt, similarity });
        }
      }
    }
  }
  if (exact.length === 0 || format.length === 0 || moderate.length === 0) {
    throw new Error("generator: merchant pool is missing an eligible class");
  }
  return { exact, format, moderate, low, competitor, allNames: [...allNames] };
}

const MERCHANTS = buildMerchantPairs();

function pickEligibleMerchantPair(rng: () => number): MerchantPair {
  const roll = rng();
  if (roll < 0.55) return pick(rng, MERCHANTS.exact);
  if (roll < 0.85) return pick(rng, MERCHANTS.format);
  if (roll < 0.95) return pick(rng, MERCHANTS.moderate);
  return pick(rng, MERCHANTS.exact);
}

function pickLowMerchantPair(rng: () => number): MerchantPair {
  return pick(rng, MERCHANTS.low);
}

function pickLowCompetitorMerchant(rng: () => number, statementMerchant: string): string {
  const candidates = MERCHANTS.competitor.filter((pair) => pair.statement === statementMerchant);
  if (candidates.length > 0) return pick(rng, candidates).receipt;
  return pick(rng, MERCHANTS.low).receipt;
}

// ---------- generator ----------

const ACCOUNTS = ["acct-rakuten", "acct-smcc", "acct-paypay"] as const;

function familyFor(index: number): Family {
  const bucket = index % 100;
  if (bucket < 45) return "clean";
  if (bucket < 75) return "noise";
  if (bucket < 85) return "near-miss";
  if (bucket < 95) return "twin";
  return "irreducible";
}

function otherAccount(rng: () => number, account: string): string {
  return pick(rng, ACCOUNTS.filter((candidate) => candidate !== account));
}

function makeStatement(
  id: string,
  merchant: string,
  amountYen: number,
  usedDate: string,
  accountIds: readonly string[] | undefined,
  kind: "purchase" | "refund" = "purchase",
): ReconciliationStatement {
  return {
    statementTransactionId: id,
    provider: "synthetic",
    externalId: `external-${id}`,
    kind,
    usedDate,
    postedDate: null,
    merchant,
    amountYen,
    paymentMethod: null,
    ...(accountIds ? { preferredAccountIds: accountIds } : {}),
  };
}

function makeReceipt(id: string, merchant: string, amountYen: number, purchasedDate: string, actualAccountId: string): ReconciliationReceipt {
  return {
    receiptId: id,
    actualTransactionId: `actual-${id}`,
    merchant,
    purchasedDate,
    amountYen,
    actualAccountId,
  };
}

function generateCase(caseIndex: number, baseSeed: number, familyOverride: Family | null): GeneratedCase {
  const family = familyOverride ?? familyFor(caseIndex);
  const seed = (baseSeed + Math.imul(caseIndex + 1, 0x9e3779b1)) >>> 0;
  const rng = makeRng(seed);
  const startDay = dayNumber("2026-09-01") + int(rng, 0, 40);
  const baseReceiptCount = int(rng, 15, 40);
  const statements: ReconciliationStatement[] = [];
  const receipts: ReconciliationReceipt[] = [];
  const truthPairs: TruthPair[] = [];
  const refundStatementIds = new Set<string>();
  const usedAmounts = new Set<number>();
  let amountCursor = 500;
  let statementCounter = 0;
  let receiptCounter = 0;
  let twinAdded = false;
  let nearMissAdded = false;
  let forcedNoiseAdded = false;

  const nextStatementId = () => `s${statementCounter++}`;
  const nextReceiptId = () => `r${receiptCounter++}`;

  const takeAmount = (): number => {
    const value = amountCursor + int(rng, 0, 60);
    amountCursor += 800;
    usedAmounts.add(value);
    return value;
  };

  const addTwin = (receipt: ReconciliationReceipt, account: string): void => {
    const id = nextReceiptId();
    receipts.push(makeReceipt(id, receipt.merchant, receipt.amountYen, receipt.purchasedDate, otherAccount(rng, account)));
  };

  const addNearMiss = (statement: ReconciliationStatement, receipt: ReconciliationReceipt): void => {
    const kind = pick(rng, ["amount", "date", "merchant"] as const);
    const id = nextReceiptId();
    if (kind === "amount") {
      const sign = rng() < 0.5 ? -1 : 1;
      let amount = Math.max(1, receipt.amountYen + int(rng, 1, 99) * sign);
      for (let attempt = 0; attempt < 8 && usedAmounts.has(amount); attempt += 1) {
        amount = Math.max(1, receipt.amountYen + int(rng, 1, 99) * sign);
      }
      if (usedAmounts.has(amount)) amount = takeAmount();
      usedAmounts.add(amount);
      receipts.push(makeReceipt(id, receipt.merchant, amount, receipt.purchasedDate, otherAccount(rng, receipt.actualAccountId)));
      return;
    }
    if (kind === "date") {
      receipts.push(makeReceipt(id, receipt.merchant, receipt.amountYen, formatDay(dayNumber(statement.usedDate) + reviewOnlyDateJitter(rng)), otherAccount(rng, receipt.actualAccountId)));
      return;
    }
    receipts.push(makeReceipt(id, pickLowCompetitorMerchant(rng, statement.merchant), receipt.amountYen, receipt.purchasedDate, otherAccount(rng, receipt.actualAccountId)));
  };

  const addTruthPair = (): void => {
    const receiptAmount = takeAmount();
    const receiptDay = startDay + int(rng, 0, 60);
    const account = pick(rng, ACCOUNTS);
    let merchantPair = pickEligibleMerchantPair(rng);
    let statementAmount = receiptAmount;
    let statementDay = receiptDay + normalDateJitter(rng);
    let intent: TruthClass = "separable";

    if (family === "noise") {
      const forceMode = !forcedNoiseAdded;
      forcedNoiseAdded = true;
      const roll = forceMode ? (caseIndex % 2 === 0 ? 0 : 1) : rng();
      if (roll < 0.1) {
        statementDay = receiptDay + reviewOnlyDateJitter(rng);
        intent = "unrecoverable";
      } else if (roll < 0.2) {
        const delta = int(rng, 1, 99) * (rng() < 0.5 ? -1 : 1);
        statementAmount = Math.max(1, receiptAmount + delta);
        intent = "unrecoverable";
      }
    }

    if (family === "irreducible") {
      intent = "unrecoverable";
      const mode = pick(rng, ["amount", "date", "merchant"] as const);
      if (mode === "amount") {
        const delta = int(rng, 1, 99) * (rng() < 0.5 ? -1 : 1);
        statementAmount = Math.max(1, receiptAmount + delta);
      } else if (mode === "date") {
        statementDay = receiptDay + reviewOnlyDateJitter(rng);
      } else {
        merchantPair = pickLowMerchantPair(rng);
      }
    }

    const statementId = nextStatementId();
    const receiptId = nextReceiptId();
    const accountIds = rng() < 0.8 ? [account] : [pick(rng, ACCOUNTS)];
    const statement = makeStatement(statementId, merchantPair.statement, statementAmount, formatDay(statementDay), accountIds);
    const receipt = makeReceipt(receiptId, merchantPair.receipt, receiptAmount, formatDay(receiptDay), account);
    statements.push(statement);
    receipts.push(receipt);
    const truthPair: TruthPair = { statementId, receiptId, intent, observedClass: intent };
    truthPairs.push(truthPair);

    if (family === "irreducible") {
      const decoyId = nextReceiptId();
      receipts.push(makeReceipt(decoyId, statement.merchant, statement.amountYen, statement.usedDate, otherAccount(rng, account)));
    }

    if (family === "twin" && (!twinAdded || rng() < 0.3)) {
      addTwin(receipt, account);
      truthPair.intent = "ambiguous";
      twinAdded = true;
    }

    if (family === "near-miss" && (!nearMissAdded || rng() < 0.4)) {
      addNearMiss(statement, receipt);
      nearMissAdded = true;
    }
  };

  const addOrphanReceipt = (): void => {
    const id = nextReceiptId();
    receipts.push(makeReceipt(id, pick(rng, MERCHANTS.allNames), takeAmount(), formatDay(startDay + int(rng, 0, 60)), pick(rng, ACCOUNTS)));
  };

  for (let index = 0; index < baseReceiptCount; index += 1) {
    if (rng() < 0.85) addTruthPair();
    else addOrphanReceipt();
  }

  if (family !== "clean") {
    const distractorCount = family === "near-miss" || family === "twin" || family === "irreducible" ? int(rng, 0, 4) : int(rng, 0, 8);
    for (let index = 0; index < distractorCount; index += 1) addOrphanReceipt();

    const refundCount = int(rng, 0, 3);
    for (let index = 0; index < refundCount; index += 1) {
      const id = nextStatementId();
      const amount = takeAmount();
      const day = formatDay(startDay + int(rng, 0, 60));
      const merchant = pick(rng, MERCHANTS.allNames);
      const refund = makeStatement(id, merchant, amount, day, undefined, "refund");
      statements.push(refund);
      refundStatementIds.add(id);
      receipts.push(makeReceipt(nextReceiptId(), merchant, amount, day, pick(rng, ACCOUNTS)));
    }
  }

  const generated: GeneratedCase = {
    id: `case-${String(caseIndex + 1).padStart(4, "0")}`,
    seed,
    family,
    statements,
    receipts,
    truthPairs,
    refundStatementIds,
  };
  assertGeneratedCase(generated);
  return generated;
}

function assertGeneratedCase(generated: GeneratedCase): void {
  const statementIds = new Set<string>();
  for (const statement of generated.statements) {
    if (statementIds.has(statement.statementTransactionId)) throw new Error(`generator: duplicate statement id ${statement.statementTransactionId}`);
    statementIds.add(statement.statementTransactionId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(statement.usedDate) || !Number.isFinite(dayNumber(statement.usedDate))) {
      throw new Error(`generator: invalid statement date ${statement.usedDate}`);
    }
    if (!Number.isSafeInteger(statement.amountYen) || statement.amountYen < 0) {
      throw new Error(`generator: invalid statement amount ${statement.amountYen}`);
    }
  }

  const receiptIds = new Set<string>();
  for (const receipt of generated.receipts) {
    if (receiptIds.has(receipt.receiptId)) throw new Error(`generator: duplicate receipt id ${receipt.receiptId}`);
    receiptIds.add(receipt.receiptId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receipt.purchasedDate) || !Number.isFinite(dayNumber(receipt.purchasedDate))) {
      throw new Error(`generator: invalid receipt date ${receipt.purchasedDate}`);
    }
    if (!Number.isSafeInteger(receipt.amountYen) || receipt.amountYen < 0) {
      throw new Error(`generator: invalid receipt amount ${receipt.amountYen}`);
    }
  }

  if (generated.truthPairs.length === 0) throw new Error("generator: case has no truth pairs");
  const truthStatements = new Set<string>();
  const truthReceipts = new Set<string>();
  for (const truth of generated.truthPairs) {
    if (!statementIds.has(truth.statementId)) throw new Error(`generator: truth statement missing ${truth.statementId}`);
    if (!receiptIds.has(truth.receiptId)) throw new Error(`generator: truth receipt missing ${truth.receiptId}`);
    if (truthStatements.has(truth.statementId)) throw new Error(`generator: statement reused by truth ${truth.statementId}`);
    if (truthReceipts.has(truth.receiptId)) throw new Error(`generator: receipt reused by truth ${truth.receiptId}`);
    truthStatements.add(truth.statementId);
    truthReceipts.add(truth.receiptId);
    if (generated.refundStatementIds.has(truth.statementId)) throw new Error("generator: refund used as truth");
  }
}

// ---------- classification and invariants ----------

type AutoFeatures = {
  amountDeltaYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
};

function autoFeatures(statement: ReconciliationStatement, receipt: ReconciliationReceipt): AutoFeatures {
  return {
    amountDeltaYen: Math.abs(statement.amountYen - receipt.amountYen),
    dateDistanceDays: Math.abs(dayNumber(statement.usedDate) - dayNumber(receipt.purchasedDate)),
    merchantSimilarity: reconciliationMerchantSimilarity(statement.merchant, receipt.merchant),
  };
}

function isAutoEligible(statement: ReconciliationStatement, receipt: ReconciliationReceipt): boolean {
  if (statement.kind !== "purchase") return false;
  const features = autoFeatures(statement, receipt);
  return features.amountDeltaYen === 0
    && features.dateDistanceDays <= PINNED_RULES.autoMatchDateWindowDays
    && features.merchantSimilarity >= PINNED_RULES.autoMatchMerchantSimilarity;
}

function dominates(statement: ReconciliationStatement, candidate: ReconciliationReceipt, truth: ReconciliationReceipt): boolean {
  if (!isAutoEligible(statement, candidate)) return false;
  const candidateFeatures = autoFeatures(statement, candidate);
  const truthFeatures = autoFeatures(statement, truth);
  return candidateFeatures.amountDeltaYen <= truthFeatures.amountDeltaYen
    && candidateFeatures.dateDistanceDays <= truthFeatures.dateDistanceDays
    && candidateFeatures.merchantSimilarity >= truthFeatures.merchantSimilarity - 1e-9;
}

function classifyTruthPair(
  statement: ReconciliationStatement,
  truthReceipt: ReconciliationReceipt,
  receipts: readonly ReconciliationReceipt[],
): TruthClass {
  if (!isAutoEligible(statement, truthReceipt)) return "unrecoverable";
  for (const receipt of receipts) {
    if (receipt.receiptId === truthReceipt.receiptId) continue;
    if (isAutoEligible(statement, receipt)) return "ambiguous";
  }
  return "separable";
}

function emptyCaseMetrics(): CaseMetrics {
  return {
    caseCount: 0,
    statementCount: 0,
    receiptCount: 0,
    truthPairCount: 0,
    separableTruthPairCount: 0,
    ambiguousTruthPairCount: 0,
    unrecoverableTruthPairCount: 0,
    autoMatchCount: 0,
    correctAutoMatchCount: 0,
    falseAutoMatchCount: 0,
    indistinguishableAutoMatchCount: 0,
    ambiguousAutoMatchCount: 0,
    ineligibleTruthAutoMatchCount: 0,
    unexplainedAutoMatchCount: 0,
    matchWithoutTruthCount: 0,
    doubleMatchCount: 0,
    refundMatchCount: 0,
    nondeterminismCount: 0,
    classificationMismatchCount: 0,
    candidateChecks: 0,
    candidateHits: 0,
    truthPairsWithoutCandidates: 0,
    ambiguousAbstentionCount: 0,
    unrecoverableAbstentionCount: 0,
  };
}

function addMetrics(target: CaseMetrics, source: CaseMetrics): void {
  for (const key of Object.keys(target) as Array<keyof CaseMetrics>) {
    target[key] += source[key];
  }
}

function finalizeMetrics(metrics: CaseMetrics): FinalMetrics {
  const precisionDenominator = metrics.correctAutoMatchCount + metrics.falseAutoMatchCount;
  return {
    ...metrics,
    autoMatchPrecision: precisionDenominator === 0 ? 1 : metrics.correctAutoMatchCount / precisionDenominator,
    autoMatchPrecisionAll: metrics.autoMatchCount === 0 ? 1 : metrics.correctAutoMatchCount / metrics.autoMatchCount,
    autoMatchCoverage: metrics.truthPairCount === 0 ? 0 : metrics.correctAutoMatchCount / metrics.truthPairCount,
    separableCoverage: metrics.separableTruthPairCount === 0 ? null : metrics.correctAutoMatchCount / metrics.separableTruthPairCount,
    candidateRecallAt3: metrics.candidateChecks === 0 ? null : metrics.candidateHits / metrics.candidateChecks,
    ambiguousAbstentionRate: metrics.ambiguousTruthPairCount === 0 ? null : metrics.ambiguousAbstentionCount / metrics.ambiguousTruthPairCount,
    unrecoverableAbstentionRate: metrics.unrecoverableTruthPairCount === 0 ? null : metrics.unrecoverableAbstentionCount / metrics.unrecoverableTruthPairCount,
  };
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function canonicalResult(result: ReconciliationEngineResult): string {
  return JSON.stringify({
    ruleVersion: result.ruleVersion,
    candidates: [...result.candidates]
      .sort((left, right) => compareText(left.statementTransactionId, right.statementTransactionId)
        || left.rank - right.rank
        || compareText(left.receiptId, right.receiptId))
      .map((candidate) => ({
        statementTransactionId: candidate.statementTransactionId,
        receiptId: candidate.receiptId,
        rank: candidate.rank,
        score: candidate.score,
        amountDeltaYen: candidate.amountDeltaYen,
        dateDistanceDays: candidate.dateDistanceDays,
        merchantSimilarity: candidate.merchantSimilarity,
        reasons: candidate.reasons,
      })),
    statementResults: [...result.statementResults]
      .sort((left, right) => compareText(left.statementTransactionId, right.statementTransactionId))
      .map((row) => ({ ...row, reasonCodes: [...row.reasonCodes].sort(compareText) })),
    receiptResults: [...result.receiptResults]
      .sort((left, right) => compareText(left.receiptId, right.receiptId))
      .map((row) => ({ ...row, reasonCodes: [...row.reasonCodes].sort(compareText) })),
  });
}

function candidatesFor(result: ReconciliationEngineResult, statementId: string): ReconciliationCandidate[] {
  return result.candidates.filter((candidate) => candidate.statementTransactionId === statementId);
}

function runCase(generated: GeneratedCase): CaseOutcome {
  const metrics = emptyCaseMetrics();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  const addViolation = (kind: string, detail: string): void => {
    violations.push({ seed: generated.seed, caseId: generated.id, family: generated.family, kind, detail });
  };

  const { statements, receipts, truthPairs, refundStatementIds } = generated;
  metrics.caseCount = 1;
  metrics.statementCount = statements.length;
  metrics.receiptCount = receipts.length;

  const statementById = new Map(statements.map((statement) => [statement.statementTransactionId, statement]));
  const receiptById = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
  const truthByStatement = new Map(truthPairs.map((truth) => [truth.statementId, truth]));

  for (const truth of truthPairs) {
    const statement = statementById.get(truth.statementId)!;
    const receipt = receiptById.get(truth.receiptId)!;
    truth.observedClass = classifyTruthPair(statement, receipt, receipts);
    if (truth.observedClass !== truth.intent) {
      metrics.classificationMismatchCount += 1;
      addViolation("classification_mismatch", `${truth.statementId}: intent=${truth.intent} observed=${truth.observedClass}`);
    }
  }

  const result = runReconciliationEngine({ statements, receipts });
  const shuffled = runReconciliationEngine({
    statements: shuffle(makeRng((generated.seed ^ 0x5bd1e995) >>> 0), statements),
    receipts: shuffle(makeRng((generated.seed ^ 0x27d4eb2f) >>> 0), receipts),
  });
  if (canonicalResult(result) !== canonicalResult(shuffled)) {
    metrics.nondeterminismCount += 1;
    addViolation("nondeterministic_result", "shuffled input changed the full result");
  }

  const statementResults = new Map(result.statementResults.map((row) => [row.statementTransactionId, row]));
  const receiptResults = new Map(result.receiptResults.map((row) => [row.receiptId, row]));
  if (statementResults.size !== statements.length) addViolation("statement_results_incomplete", `${statementResults.size}/${statements.length}`);
  if (receiptResults.size !== receipts.length) addViolation("receipt_results_incomplete", `${receiptResults.size}/${receipts.length}`);

  const matchedStatements = result.statementResults.filter((row) => row.status === "matched");
  const matchedReceipts = result.receiptResults.filter((row) => row.status === "matched");
  metrics.autoMatchCount = matchedStatements.length;

  // I2: one-to-one, mirror, and complete result rows.
  const receiptUsage = new Map<string, string>();
  const statementUsage = new Map<string, string>();
  for (const row of matchedStatements) {
    if (!row.matchedReceiptId) {
      addViolation("matched_statement_without_receipt", row.statementTransactionId);
      continue;
    }
    if (receiptUsage.has(row.matchedReceiptId)) {
      metrics.doubleMatchCount += 1;
      addViolation("double_receipt", `${row.matchedReceiptId} used by ${receiptUsage.get(row.matchedReceiptId)} and ${row.statementTransactionId}`);
    }
    receiptUsage.set(row.matchedReceiptId, row.statementTransactionId);
    const mirror = receiptResults.get(row.matchedReceiptId);
    if (!mirror || mirror.status !== "matched" || mirror.matchedStatementTransactionId !== row.statementTransactionId) {
      metrics.doubleMatchCount += 1;
      addViolation("mirror_mismatch", `${row.statementTransactionId} -> ${row.matchedReceiptId} has no reciprocal receipt result`);
    }
  }
  for (const row of matchedReceipts) {
    if (!row.matchedStatementTransactionId) {
      addViolation("matched_receipt_without_statement", row.receiptId);
      continue;
    }
    if (statementUsage.has(row.matchedStatementTransactionId)) {
      metrics.doubleMatchCount += 1;
      addViolation("double_statement", `${row.matchedStatementTransactionId} used by ${statementUsage.get(row.matchedStatementTransactionId)} and ${row.receiptId}`);
    }
    statementUsage.set(row.matchedStatementTransactionId, row.receiptId);
    const mirror = statementResults.get(row.matchedStatementTransactionId);
    if (!mirror || mirror.status !== "matched" || mirror.matchedReceiptId !== row.receiptId) {
      metrics.doubleMatchCount += 1;
      addViolation("mirror_mismatch", `${row.receiptId} -> ${row.matchedStatementTransactionId} has no reciprocal statement result`);
    }
  }
  if (matchedStatements.length !== matchedReceipts.length) {
    metrics.doubleMatchCount += 1;
    addViolation("match_count_mismatch", `statements=${matchedStatements.length} receipts=${matchedReceipts.length}`);
  }

  // I3: refunds are never matched and never produce candidates.
  for (const refundId of refundStatementIds) {
    const statement = statementById.get(refundId)!;
    const row = statementResults.get(refundId);
    let failed = false;
    if (!row || row.status !== "unmatched_statement" || !row.reasonCodes.includes("refund_not_supported")) {
      failed = true;
      addViolation("refund_not_excluded", `${refundId} status=${row?.status ?? "missing"}`);
    }
    if (candidatesFor(result, refundId).length > 0) {
      failed = true;
      addViolation("refund_has_candidate", refundId);
    }
    if (matchedReceipts.some((item) => item.matchedStatementTransactionId === refundId)) {
      failed = true;
      addViolation("refund_matched_to_receipt", refundId);
    }
    if (failed) metrics.refundMatchCount += 1;
    if (statement.kind !== "refund") addViolation("refund_kind_mismatch", refundId);
  }

  // I1: automatic matches must be separable truth pairs, or documented irreducible matches.
  let accountedAutoMatches = 0;
  for (const row of matchedStatements) {
    accountedAutoMatches += 1;
    const statement = statementById.get(row.statementTransactionId);
    const matchedReceipt = row.matchedReceiptId ? receiptById.get(row.matchedReceiptId) : undefined;
    if (!statement || !matchedReceipt) {
      metrics.unexplainedAutoMatchCount += 1;
      addViolation("matched_row_missing_input", row.statementTransactionId);
      continue;
    }
    const truth = truthByStatement.get(row.statementTransactionId);
    if (!truth) {
      metrics.matchWithoutTruthCount += 1;
      addViolation("match_without_truth", `${row.statementTransactionId} -> ${matchedReceipt.receiptId}`);
      continue;
    }
    const truthReceipt = receiptById.get(truth.receiptId);
    if (!truthReceipt) {
      metrics.unexplainedAutoMatchCount += 1;
      addViolation("truth_receipt_missing", truth.receiptId);
      continue;
    }

    if (truth.observedClass === "separable") {
      if (matchedReceipt.receiptId === truth.receiptId) {
        metrics.correctAutoMatchCount += 1;
      } else {
        metrics.falseAutoMatchCount += 1;
        addViolation("false_auto_match", `${row.statementTransactionId} -> ${matchedReceipt.receiptId}; truth=${truth.receiptId}`);
      }
      continue;
    }

    if (truth.observedClass === "ambiguous") {
      metrics.ambiguousAutoMatchCount += 1;
      addViolation("ambiguous_auto_match", `${row.statementTransactionId} -> ${matchedReceipt.receiptId}; truth=${truth.receiptId}`);
      continue;
    }

    if (matchedReceipt.receiptId === truth.receiptId) {
      metrics.ineligibleTruthAutoMatchCount += 1;
      addViolation("ineligible_truth_auto_match", `${row.statementTransactionId} matched truth=${truth.receiptId} despite being unrecoverable`);
      continue;
    }
    if (dominates(statement, matchedReceipt, truthReceipt)) {
      metrics.indistinguishableAutoMatchCount += 1;
      const matchedFeatures = autoFeatures(statement, matchedReceipt);
      const truthFeatures = autoFeatures(statement, truthReceipt);
      indistinguishable.push({
        seed: generated.seed,
        caseId: generated.id,
        family: generated.family,
        statementId: row.statementTransactionId,
        matchedReceiptId: matchedReceipt.receiptId,
        truthReceiptId: truthReceipt.receiptId,
        matchedAmountDeltaYen: matchedFeatures.amountDeltaYen,
        truthAmountDeltaYen: truthFeatures.amountDeltaYen,
        matchedDateDistanceDays: matchedFeatures.dateDistanceDays,
        truthDateDistanceDays: truthFeatures.dateDistanceDays,
        matchedMerchantSimilarity: matchedFeatures.merchantSimilarity,
        truthMerchantSimilarity: truthFeatures.merchantSimilarity,
      });
      continue;
    }
    metrics.unexplainedAutoMatchCount += 1;
    addViolation("unexplained_false_auto_match", `${row.statementTransactionId} -> ${matchedReceipt.receiptId}; truth=${truth.receiptId}, no dominance`);
  }
  if (accountedAutoMatches !== metrics.autoMatchCount) addViolation("accounting_mismatch", "auto match accounting drifted");

  // I6: the automatic pair must remain visible in the top three review candidates.
  for (const row of matchedStatements) {
    if (!row.matchedReceiptId) continue;
    if (!candidatesFor(result, row.statementTransactionId).some((candidate) => candidate.receiptId === row.matchedReceiptId && candidate.rank <= 3)) {
      addViolation("auto_match_not_in_candidates", `${row.statementTransactionId} -> ${row.matchedReceiptId}`);
    }
  }

  // Truth accounting, abstention, and candidate recall.
  for (const truth of truthPairs) {
    metrics.truthPairCount += 1;
    const statement = statementById.get(truth.statementId)!;
    const candidates = candidatesFor(result, truth.statementId);
    if (truth.observedClass === "separable") metrics.separableTruthPairCount += 1;
    else if (truth.observedClass === "ambiguous") metrics.ambiguousTruthPairCount += 1;
    else metrics.unrecoverableTruthPairCount += 1;

    if (candidates.length === 0) {
      metrics.truthPairsWithoutCandidates += 1;
      addViolation("expected_review_candidate_missing", `${truth.statementId} (${truth.observedClass})`);
    } else {
      metrics.candidateChecks += 1;
      if (candidates.some((candidate) => candidate.receiptId === truth.receiptId && candidate.rank <= 3)) metrics.candidateHits += 1;
    }

    const row = statementResults.get(truth.statementId);
    if (truth.observedClass === "ambiguous" && row?.status !== "matched") metrics.ambiguousAbstentionCount += 1;
    if (truth.observedClass === "unrecoverable" && row?.status !== "matched") metrics.unrecoverableAbstentionCount += 1;
    if (statement.kind === "refund") addViolation("truth_statement_is_refund", truth.statementId);
  }

  // Status semantics for purchases and receipts.
  for (const statement of statements) {
    if (statement.kind === "refund") continue;
    const row = statementResults.get(statement.statementTransactionId);
    const candidates = candidatesFor(result, statement.statementTransactionId);
    if (!row) {
      addViolation("statement_result_missing", statement.statementTransactionId);
      continue;
    }
    if (row.status === "matched" && !row.reasonCodes.includes("automatic_high_confidence_match")) {
      addViolation("matched_reason_missing", statement.statementTransactionId);
    }
    if (row.status === "needs_review" && candidates.length === 0) {
      addViolation("needs_review_without_candidate", statement.statementTransactionId);
    }
    if (row.status === "unmatched_statement" && candidates.length > 0) {
      addViolation("unmatched_with_candidate", statement.statementTransactionId);
    }
    if (String(row.status) === "confirmed") addViolation("confirmed_status_emitted", statement.statementTransactionId);
  }

  for (const receipt of receipts) {
    const row = receiptResults.get(receipt.receiptId);
    const candidates = result.candidates.filter((candidate) => candidate.receiptId === receipt.receiptId);
    if (!row) {
      addViolation("receipt_result_missing", receipt.receiptId);
      continue;
    }
    if (row.status === "matched" && !row.reasonCodes.includes("automatic_high_confidence_match")) {
      addViolation("matched_reason_missing", receipt.receiptId);
    }
    // Receipt candidates are not capped by the statement's top three; a receipt can
    // legitimately be needs_review even when no output candidate row names it.
    if (row.status === "unmatched_receipt" && candidates.length > 0) {
      addViolation("unmatched_with_candidate", receipt.receiptId);
    }
    if (String(row.status) === "confirmed") addViolation("confirmed_status_emitted", receipt.receiptId);
  }

  return { generated, metrics, violations, indistinguishable };
}

// ---------- CLI, contract, and report ----------

function parseOptions(argv: readonly string[]): Options | null {
  let cases = DEFAULT_CASES;
  let seed = DEFAULT_SEED;
  let family: Family | null = null;
  let maxViolations = 50;
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.error("Usage: pnpm eval:reconciliation-property -- [--cases=1200] [--seed=376] [--family=clean|noise|near-miss|twin|irreducible] [--max-violations=50]");
      return null;
    }
    if (argument.startsWith("--cases=")) {
      cases = Number(argument.slice("--cases=".length));
      continue;
    }
    if (argument.startsWith("--seed=")) {
      seed = Number(argument.slice("--seed=".length));
      continue;
    }
    if (argument.startsWith("--family=")) {
      const value = argument.slice("--family=".length);
      if (!FAMILIES.includes(value as Family)) throw new Error(`unknown family: ${value}`);
      family = value as Family;
      continue;
    }
    if (argument.startsWith("--max-violations=")) {
      maxViolations = Number(argument.slice("--max-violations=".length));
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(cases) || cases <= 0) throw new Error("--cases must be a positive integer");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("--seed must be a 32-bit unsigned integer");
  if (!Number.isInteger(maxViolations) || maxViolations < 0) throw new Error("--max-violations must be a non-negative integer");
  return { cases, seed, family, maxViolations };
}

function checkRuleContract(): void {
  const actual = RECONCILIATION_RULES;
  for (const key of Object.keys(PINNED_RULES) as Array<keyof typeof PINNED_RULES>) {
    if (actual[key] !== PINNED_RULES[key]) {
      throw new Error(`rule contract changed: ${key}=${String(actual[key])}, expected ${String(PINNED_RULES[key])}`);
    }
  }
  if (RECONCILIATION_RULE_VERSION !== PINNED_RULE_VERSION) {
    throw new Error(`rule version changed: ${RECONCILIATION_RULE_VERSION}, expected ${PINNED_RULE_VERSION}`);
  }
}

function countViolations(violations: readonly Violation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const violation of violations) counts[violation.kind] = (counts[violation.kind] ?? 0) + 1;
  return counts;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  checkRuleContract();

  const totals = emptyCaseMetrics();
  const byFamily = new Map<Family, CaseMetrics>();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  for (let index = 0; index < options.cases; index += 1) {
    const generated = generateCase(index, options.seed, options.family);
    const outcome = runCase(generated);
    addMetrics(totals, outcome.metrics);
    const familyTotals = byFamily.get(generated.family) ?? emptyCaseMetrics();
    addMetrics(familyTotals, outcome.metrics);
    byFamily.set(generated.family, familyTotals);
    violations.push(...outcome.violations);
    indistinguishable.push(...outcome.indistinguishable);
  }

  const metrics = finalizeMetrics(totals);
  const byFamilyReport: Record<string, FinalMetrics> = {};
  for (const family of FAMILIES) {
    const familyMetrics = byFamily.get(family);
    if (familyMetrics) byFamilyReport[family] = finalizeMetrics(familyMetrics);
  }

  const report = {
    dataset: "eval/run-reconciliation-property.ts",
    generatorVersion: "1",
    seed: options.seed,
    ruleVersion: RECONCILIATION_RULE_VERSION,
    config: {
      cases: options.cases,
      family: options.family,
      maxViolations: options.maxViolations,
      pinnedRuleVersion: PINNED_RULE_VERSION,
    },
    metrics,
    byFamily: byFamilyReport,
    violationCount: violations.length,
    violationCounts: countViolations(violations),
    violations: violations.slice(0, options.maxViolations),
    indistinguishableCount: indistinguishable.length,
    indistinguishable: indistinguishable.slice(0, options.maxViolations),
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error: unknown) {
  console.error(JSON.stringify({
    dataset: "eval/run-reconciliation-property.ts",
    error: "property_eval_failed",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}
