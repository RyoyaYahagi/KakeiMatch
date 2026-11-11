/**
 * Property-based evaluation for the reconciliation engine.
 *
 * Generates seeded ledgers and statements with known ground-truth pairs, then
 * checks safety invariants over many cases: no false automatic match, no double
 * match, no refund match, deterministic output, and rule-contract stability.
 *
 * It also runs the Issue #380 gate: the 900 base cases and 800 robustness cases
 * from the PR #381 harness, with expectations measured on rule 1.2.0.
 *
 * Run with:
 *   node --conditions=react-server --import tsx eval/run-reconciliation-property.ts
 */

import {
  inspectReconciliationRanking,
  RECONCILIATION_RULES,
  RECONCILIATION_RULE_VERSION,
  reconciliationMerchantSimilarity,
  runReconciliationEngine,
  type ReconciliationCandidate,
  type ReconciliationEngineResult,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";
import {
  GATE_FAMILIES,
  GATE_ROBUSTNESS_VARIANTS,
  GATE_SEEDS,
  generateGateDataset,
  generateGateDedicatedCases,
  type GateCase,
  type GateFamily,
} from "./reconciliation-gate-dataset";
import { runReconciliationEngine as runFrozenEngine } from "./frozen/reconciliation-engine-1.2.0";

const DAY = 86_400_000;
const DEFAULT_CASES = 1_200;
const DEFAULT_SEED = 376;
const PINNED_RULE_VERSION = "1.2.2";
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
  family: Family | GateFamily;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  truthPairs: TruthPair[];
  refundStatementIds: Set<string>;
  /** Aliases are only used by the gate's alias family. */
  aliases?: ReadonlySet<string>;
  /**
   * Gate cases fix the separable/ambiguous class at generation time, matching
   * the PR #381 harness. Property cases recompute it from the generated records.
   */
  fixedTruthClass?: boolean;
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
  family: Family | GateFamily;
  kind: string;
  detail: string;
};

type IndistinguishableMatch = {
  seed: number;
  caseId: string;
  family: Family | GateFamily;
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
  ruleVersionMismatchCount: number;
  candidateChecks: number;
  candidateHits: number;
  truthPairsWithoutCandidates: number;
  ambiguousAbstentionCount: number;
  unrecoverableAbstentionCount: number;
};

type FinalMetrics = CaseMetrics & {
  autoMatchPrecision: number;
  autoMatchPrecisionAll: number;
  invalidAutoMatchCount: number;
  autoMatchCoverage: number;
  separableCoverage: number | null;
  candidateRecallAt3: number | null;
  ambiguousAbstentionRate: number | null;
  unrecoverableAbstentionRate: number | null;
};

type LegacyMetrics = {
  oldAutoMatchCount: number;
  oldCorrectAutoMatchCount: number;
  oldInvalidAutoMatchCount: number;
  /** Old correct pairs that the current engine no longer confirms. */
  lostLegacyAutoMatchCount: number;
  /** Invalid pairs that are new relative to the frozen 1.2.0 baseline. */
  newInvalidAutoMatchCount: number;
  /** Statements whose candidate set was compared with the frozen 1.2.0 output. */
  candidateSetCheckedStatementCount: number;
  /** Statements whose candidate set differs from the frozen 1.2.0 output. */
  candidateSetMismatchStatementCount: number;
  /** Frozen 1.2.0 candidate pairs that the current output no longer contains. */
  candidateSetMissingCount: number;
  /** Current candidate pairs that the frozen 1.2.0 output did not contain. */
  candidateSetExtraCount: number;
};

type CaseOutcome = {
  generated: GeneratedCase;
  metrics: CaseMetrics;
  violations: Violation[];
  indistinguishable: IndistinguishableMatch[];
  ruleVersions: string[];
  legacy: LegacyMetrics | null;
  result: ReconciliationEngineResult;
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

type MerchantSimilarityFixture = {
  label: string;
  statement: string;
  receipt: string;
  expectedSimilarity: number;
  expectedEligible: boolean;
};

/**
 * Pinned values captured from rule 1.2.0, deliberately independent of the
 * merchant pool builder and of the engine's current similarity implementation.
 * If the engine changes similarity, these checks fail instead of silently
 * reclassifying the generated cases as still valid.
 */
const MERCHANT_SIMILARITY_FIXTURES: readonly MerchantSimilarityFixture[] = [
  { label: "separator-normalization", statement: "セブンイレブン", receipt: "セブン-イレブン", expectedSimilarity: 1, expectedEligible: true },
  { label: "halfwidth-kana", statement: "アオゾラストア", receipt: "ｱｵｿﾞﾗｽﾄｱ", expectedSimilarity: 1, expectedEligible: true },
  { label: "ascii-case", statement: "Amazon", receipt: "AMAZON", expectedSimilarity: 1, expectedEligible: true },
  { label: "moderate-variant", statement: "ファミリーマート", receipt: "ファミリ-マート", expectedSimilarity: 0.7692307692307693, expectedEligible: true },
  { label: "just-below-threshold-store-suffix", statement: "セブンイレブン", receipt: "セブン‐イレブン 群大前店", expectedSimilarity: 0.7142857142857143, expectedEligible: false },
  { label: "just-below-threshold-domain", statement: "Amazon", receipt: "Amazon.co.jp", expectedSimilarity: 0.7142857142857143, expectedEligible: false },
  { label: "kana-variant-not-auto", statement: "アオゾラストア", receipt: "あおぞらストア", expectedSimilarity: 0.3333333333333333, expectedEligible: false },
  { label: "zero-aeon", statement: "イオン", receipt: "AEON", expectedSimilarity: 0, expectedEligible: false },
  { label: "zero-lawson", statement: "ローソン", receipt: "LAWSON", expectedSimilarity: 0, expectedEligible: false },
  { label: "abbreviation", statement: "マツモトキヨシ", receipt: "マツキヨ", expectedSimilarity: 0.4444444444444444, expectedEligible: false },
  { label: "shared-prefix-different-store", statement: "アオゾラストア", receipt: "アオゾラカフェ", expectedSimilarity: 0.5, expectedEligible: false },
];

function checkMerchantSimilarityContract(): void {
  for (const fixture of MERCHANT_SIMILARITY_FIXTURES) {
    const actual = reconciliationMerchantSimilarity(fixture.statement, fixture.receipt);
    if (Math.abs(actual - fixture.expectedSimilarity) > 1e-9) {
      throw new Error(`merchant similarity contract changed (${fixture.label}): actual=${actual}, expected=${fixture.expectedSimilarity}`);
    }
    const eligible = actual >= PINNED_RULES.autoMatchMerchantSimilarity;
    if (eligible !== fixture.expectedEligible) {
      throw new Error(`merchant eligibility contract changed (${fixture.label}): actual=${eligible}, expected=${fixture.expectedEligible}`);
    }
  }
}

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
    ruleVersionMismatchCount: 0,
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
  const invalidAutoMatchCount = metrics.falseAutoMatchCount
    + metrics.ambiguousAutoMatchCount
    + metrics.ineligibleTruthAutoMatchCount
    + metrics.unexplainedAutoMatchCount
    + metrics.matchWithoutTruthCount;
  const precisionDenominator = metrics.correctAutoMatchCount + invalidAutoMatchCount;
  return {
    ...metrics,
    invalidAutoMatchCount,
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

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

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

function pairKey(statementId: string, receiptId: string): string {
  return `${statementId}\u0000${receiptId}`;
}

function autoPairKeys(result: { statementResults: Array<{ statementTransactionId: string; status: string; matchedReceiptId: string | null }> }): Set<string> {
  const pairs = new Set<string>();
  for (const row of result.statementResults) {
    if (row.status === "matched" && row.matchedReceiptId) pairs.add(pairKey(row.statementTransactionId, row.matchedReceiptId));
  }
  return pairs;
}

function runCase(generated: GeneratedCase): CaseOutcome {
  const metrics = emptyCaseMetrics();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  const addViolation = (kind: string, detail: string): void => {
    violations.push({ seed: generated.seed, caseId: generated.id, family: generated.family, kind, detail });
  };

  const { statements, receipts, truthPairs, refundStatementIds } = generated;
  const aliases = generated.aliases;
  metrics.caseCount = 1;
  metrics.statementCount = statements.length;
  metrics.receiptCount = receipts.length;

  const statementById = new Map(statements.map((statement) => [statement.statementTransactionId, statement]));
  const receiptById = new Map(receipts.map((receipt) => [receipt.receiptId, receipt]));
  const truthByStatement = new Map(truthPairs.map((truth) => [truth.statementId, truth]));

  for (const truth of truthPairs) {
    if (generated.fixedTruthClass) {
      truth.observedClass = truth.intent;
      continue;
    }
    const statement = statementById.get(truth.statementId)!;
    const receipt = receiptById.get(truth.receiptId)!;
    truth.observedClass = classifyTruthPair(statement, receipt, receipts);
    if (truth.observedClass !== truth.intent) {
      metrics.classificationMismatchCount += 1;
      addViolation("classification_mismatch", `${truth.statementId}: intent=${truth.intent} observed=${truth.observedClass}`);
    }
  }

  const result = runReconciliationEngine({ statements, receipts, aliases });
  const shuffled = runReconciliationEngine({
    statements: shuffle(makeRng((generated.seed ^ 0x5bd1e995) >>> 0), statements),
    receipts: shuffle(makeRng((generated.seed ^ 0x27d4eb2f) >>> 0), receipts),
    aliases,
  });
  const ruleVersions = [result.ruleVersion, shuffled.ruleVersion];
  for (const [label, version] of [["base", result.ruleVersion], ["shuffled", shuffled.ruleVersion]] as const) {
    if (version !== PINNED_RULE_VERSION) {
      metrics.ruleVersionMismatchCount += 1;
      addViolation("rule_version_mismatch", `${label}: actual=${version}, expected=${PINNED_RULE_VERSION}`);
    }
  }
  if (canonicalResult(result) !== canonicalResult(shuffled)) {
    metrics.nondeterminismCount += 1;
    addViolation("nondeterministic_result", "shuffled input changed the full result");
  }

  let legacy: LegacyMetrics | null = null;
  if (generated.fixedTruthClass) {
    const oldResult = runFrozenEngine({ statements, receipts, aliases });
    const newPairs = autoPairKeys(result);
    const oldPairs = autoPairKeys(oldResult);
    const acceptable = new Set(
      truthPairs.filter((truth) => truth.observedClass === "separable").map((truth) => pairKey(truth.statementId, truth.receiptId)),
    );
    const oldCorrect = [...oldPairs].filter((key) => acceptable.has(key));
    const oldInvalid = [...oldPairs].filter((key) => !acceptable.has(key));
    const newInvalid = [...newPairs].filter((key) => !acceptable.has(key));
    const candidatesByStatement = (rows: ReconciliationEngineResult["candidates"]) => {
      const sets = new Map<string, Set<string>>();
      for (const candidate of rows) {
        const set = sets.get(candidate.statementTransactionId) ?? new Set<string>();
        set.add(candidate.receiptId);
        sets.set(candidate.statementTransactionId, set);
      }
      return sets;
    };
    const oldCandidateSets = candidatesByStatement(oldResult.candidates);
    const newCandidateSets = candidatesByStatement(result.candidates);
    let candidateSetCheckedStatementCount = 0;
    let candidateSetMismatchStatementCount = 0;
    let candidateSetMissingCount = 0;
    let candidateSetExtraCount = 0;
    for (const statement of statements) {
      candidateSetCheckedStatementCount += 1;
      const oldSet = oldCandidateSets.get(statement.statementTransactionId) ?? new Set<string>();
      const newSet = newCandidateSets.get(statement.statementTransactionId) ?? new Set<string>();
      const missing = [...oldSet].filter((receiptId) => !newSet.has(receiptId));
      const extra = [...newSet].filter((receiptId) => !oldSet.has(receiptId));
      candidateSetMissingCount += missing.length;
      candidateSetExtraCount += extra.length;
      if (missing.length > 0 || extra.length > 0) candidateSetMismatchStatementCount += 1;
    }
    legacy = {
      oldAutoMatchCount: oldPairs.size,
      oldCorrectAutoMatchCount: oldCorrect.length,
      oldInvalidAutoMatchCount: oldInvalid.length,
      lostLegacyAutoMatchCount: oldCorrect.filter((key) => !newPairs.has(key)).length,
      newInvalidAutoMatchCount: newInvalid.filter((key) => !oldPairs.has(key)).length,
      candidateSetCheckedStatementCount,
      candidateSetMismatchStatementCount,
      candidateSetMissingCount,
      candidateSetExtraCount,
    };
  }

  const statementResultIds = result.statementResults.map((row) => row.statementTransactionId);
  const receiptResultIds = result.receiptResults.map((row) => row.receiptId);
  const statementResultIdSet = new Set(statementResultIds);
  const receiptResultIdSet = new Set(receiptResultIds);
  const inputStatementIds = new Set(statements.map((statement) => statement.statementTransactionId));
  const inputReceiptIds = new Set(receipts.map((receipt) => receipt.receiptId));

  if (result.statementResults.length !== statements.length) {
    addViolation("statement_results_count_mismatch", `${result.statementResults.length}/${statements.length}`);
  }
  if (result.receiptResults.length !== receipts.length) {
    addViolation("receipt_results_count_mismatch", `${result.receiptResults.length}/${receipts.length}`);
  }
  const duplicateStatementResults = duplicateIds(statementResultIds);
  const duplicateReceiptResults = duplicateIds(receiptResultIds);
  if (duplicateStatementResults.length > 0) {
    addViolation("duplicate_statement_result_rows", duplicateStatementResults.slice(0, 5).join(", "));
  }
  if (duplicateReceiptResults.length > 0) {
    addViolation("duplicate_receipt_result_rows", duplicateReceiptResults.slice(0, 5).join(", "));
  }
  const missingStatementResults = [...inputStatementIds].filter((id) => !statementResultIdSet.has(id));
  const extraStatementResults = [...statementResultIdSet].filter((id) => !inputStatementIds.has(id));
  if (missingStatementResults.length > 0 || extraStatementResults.length > 0) {
    addViolation("statement_result_id_set_mismatch", `missing=${missingStatementResults.slice(0, 5).join(",") || "-"} extra=${extraStatementResults.slice(0, 5).join(",") || "-"}`);
  }
  const missingReceiptResults = [...inputReceiptIds].filter((id) => !receiptResultIdSet.has(id));
  const extraReceiptResults = [...receiptResultIdSet].filter((id) => !inputReceiptIds.has(id));
  if (missingReceiptResults.length > 0 || extraReceiptResults.length > 0) {
    addViolation("receipt_result_id_set_mismatch", `missing=${missingReceiptResults.slice(0, 5).join(",") || "-"} extra=${extraReceiptResults.slice(0, 5).join(",") || "-"}`);
  }

  const statementResults = new Map(result.statementResults.map((row) => [row.statementTransactionId, row]));
  const receiptResults = new Map(result.receiptResults.map((row) => [row.receiptId, row]));

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
  for (const row of matchedStatements) {
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

    const truthReceipt = receiptById.get(truth.receiptId);
    if (!truthReceipt) {
      metrics.unexplainedAutoMatchCount += 1;
      addViolation("truth_receipt_missing", truth.receiptId);
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
  const classifiedAutoMatches = metrics.correctAutoMatchCount
    + metrics.falseAutoMatchCount
    + metrics.ambiguousAutoMatchCount
    + metrics.ineligibleTruthAutoMatchCount
    + metrics.indistinguishableAutoMatchCount
    + metrics.unexplainedAutoMatchCount
    + metrics.matchWithoutTruthCount;
  if (classifiedAutoMatches !== metrics.autoMatchCount) {
    addViolation("accounting_mismatch", `classified=${classifiedAutoMatches}, autoMatchCount=${metrics.autoMatchCount}`);
  }

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
    const hasTruthReceipt = receiptById.has(truth.receiptId);
    if (truth.observedClass === "separable") metrics.separableTruthPairCount += 1;
    else if (truth.observedClass === "ambiguous") metrics.ambiguousTruthPairCount += 1;
    else metrics.unrecoverableTruthPairCount += 1;

    const row = statementResults.get(truth.statementId);
    if (truth.observedClass === "ambiguous" && row?.status !== "matched") metrics.ambiguousAbstentionCount += 1;
    if (truth.observedClass === "unrecoverable" && row?.status !== "matched") metrics.unrecoverableAbstentionCount += 1;
    if (statement.kind === "refund") addViolation("truth_statement_is_refund", truth.statementId);

    // A missing truth receipt has no correct candidate to rank; abstaining is
    // the only safe outcome and is already checked by I1.
    if (!hasTruthReceipt) continue;
    if (candidates.length === 0) {
      metrics.truthPairsWithoutCandidates += 1;
      addViolation("expected_review_candidate_missing", `${truth.statementId} (${truth.observedClass})`);
    } else {
      metrics.candidateChecks += 1;
      if (candidates.some((candidate) => candidate.receiptId === truth.receiptId && candidate.rank <= 3)) metrics.candidateHits += 1;
    }
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

  return { generated, metrics, violations, indistinguishable, ruleVersions, legacy, result };
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
      console.error("The 1,700-case Issue #380 gate always runs in addition to the property cases.");
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
  checkMerchantSimilarityContract();
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

/**
 * Expected correct automatic confirmations per family, measured with rule
 * 1.2.0 on the 1,700-case gate. Treated as a floor: a future engine may add
 * correct confirmations, but losing one fails the gate.
 */
const GATE_EXPECTED_CASE_COUNT = 1_700;

const GATE_EXPECTED_CORRECT: Record<GateFamily, number> = {
  "chain-2": 100,
  "chain-3": 100,
  "chain-5": 100,
  "chain-10": 100,
  twin: 100,
  missing: 100,
  extra: 100,
  threshold: 100,
  alias: 100,
  "chain-mixed-missing": 200,
  "chain-mixed-extra": 200,
  "chain-mixed-decoy": 200,
  "chain-mixed-missing-decoy": 200,
};

type GateFamilyReport = FinalMetrics & LegacyMetrics & {
  expectedCorrect: number;
  expectedCorrectMet: boolean;
};

type RankingMetrics = {
  assignmentCount: number;
  assignedFirstCount: number;
  assignmentDoubleCount: number;
  separableFirstCandidateChecks: number;
  separableFirstCandidateHits: number;
  reviewSeparableFirstCandidateChecks: number;
  reviewSeparableFirstCandidateHits: number;
};

function emptyRankingMetrics(): RankingMetrics {
  return {
    assignmentCount: 0,
    assignedFirstCount: 0,
    assignmentDoubleCount: 0,
    separableFirstCandidateChecks: 0,
    separableFirstCandidateHits: 0,
    reviewSeparableFirstCandidateChecks: 0,
    reviewSeparableFirstCandidateHits: 0,
  };
}

function rankingRate(hits: number, checks: number): number | null {
  return checks === 0 ? null : hits / checks;
}

function gateCaseToGenerated(gateCase: GateCase): GeneratedCase {
  return {
    id: gateCase.id,
    seed: gateCase.seed,
    family: gateCase.family,
    statements: gateCase.statements,
    receipts: gateCase.receipts,
    truthPairs: gateCase.truthPairs.map((truth) => ({
      statementId: truth.statementId,
      receiptId: truth.receiptId,
      intent: truth.truthClass,
      observedClass: truth.truthClass,
    })),
    refundStatementIds: new Set<string>(),
    aliases: new Set(gateCase.aliases),
    fixedTruthClass: true,
  };
}

function emptyLegacy(): LegacyMetrics {
  return {
    oldAutoMatchCount: 0,
    oldCorrectAutoMatchCount: 0,
    oldInvalidAutoMatchCount: 0,
    lostLegacyAutoMatchCount: 0,
    newInvalidAutoMatchCount: 0,
    candidateSetCheckedStatementCount: 0,
    candidateSetMismatchStatementCount: 0,
    candidateSetMissingCount: 0,
    candidateSetExtraCount: 0,
  };
}

function addLegacy(target: LegacyMetrics, source: LegacyMetrics): void {
  for (const key of Object.keys(target) as Array<keyof LegacyMetrics>) target[key] += source[key];
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  checkRuleContract();

  const totals = emptyCaseMetrics();
  const byFamily = new Map<Family, CaseMetrics>();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  const observedRuleVersions = new Set<string>();
  for (let index = 0; index < options.cases; index += 1) {
    const generated = generateCase(index, options.seed, options.family);
    const outcome = runCase(generated);
    addMetrics(totals, outcome.metrics);
    const family = generated.family as Family;
    const familyTotals = byFamily.get(family) ?? emptyCaseMetrics();
    addMetrics(familyTotals, outcome.metrics);
    byFamily.set(family, familyTotals);
    violations.push(...outcome.violations);
    indistinguishable.push(...outcome.indistinguishable);
    for (const version of outcome.ruleVersions) observedRuleVersions.add(version);
  }

  const metrics = finalizeMetrics(totals);
  const observedRuleVersionList = [...observedRuleVersions].sort(compareText);
  const byFamilyReport: Record<string, FinalMetrics> = {};
  for (const family of FAMILIES) {
    const familyMetrics = byFamily.get(family);
    if (familyMetrics) byFamilyReport[family] = finalizeMetrics(familyMetrics);
  }

  const gateCases = generateGateDataset();
  const robustnessCaseCount = 2 * GATE_SEEDS * GATE_ROBUSTNESS_VARIANTS.length;
  const gateTotals = emptyCaseMetrics();
  const gateByFamily = new Map<GateFamily, CaseMetrics>();
  const gateLegacyTotals = emptyLegacy();
  const gateLegacyByFamily = new Map<GateFamily, LegacyMetrics>();
  const gateViolations: Violation[] = [];
  const gateRanking = emptyRankingMetrics();
  for (const gateCase of gateCases) {
    const generated = gateCaseToGenerated(gateCase);
    const outcome = runCase(generated);
    addMetrics(gateTotals, outcome.metrics);
    const familyTotals = gateByFamily.get(gateCase.family) ?? emptyCaseMetrics();
    addMetrics(familyTotals, outcome.metrics);
    gateByFamily.set(gateCase.family, familyTotals);
    if (!outcome.legacy) throw new Error(`gate case ${gateCase.id} did not produce legacy metrics`);
    addLegacy(gateLegacyTotals, outcome.legacy);
    const legacyTotals = gateLegacyByFamily.get(gateCase.family) ?? emptyLegacy();
    addLegacy(legacyTotals, outcome.legacy);
    gateLegacyByFamily.set(gateCase.family, legacyTotals);
    gateViolations.push(...outcome.violations);

    const candidatesByStatement = new Map<string, ReconciliationCandidate[]>();
    for (const candidate of outcome.result.candidates) {
      const list = candidatesByStatement.get(candidate.statementTransactionId) ?? [];
      list.push(candidate);
      candidatesByStatement.set(candidate.statementTransactionId, list);
    }
    const statementResultById = new Map(outcome.result.statementResults.map((row) => [row.statementTransactionId, row]));
    const ranking = inspectReconciliationRanking({
      statements: gateCase.statements, receipts: gateCase.receipts, aliases: new Set(gateCase.aliases),
    });
    const usedReceipts = new Set<string>();
    for (const pair of ranking.assignments) {
      gateRanking.assignmentCount += 1;
      if (usedReceipts.has(pair.receiptId)) gateRanking.assignmentDoubleCount += 1;
      usedReceipts.add(pair.receiptId);
      const first = candidatesByStatement.get(pair.statementTransactionId)?.[0];
      if (first?.receiptId === pair.receiptId) gateRanking.assignedFirstCount += 1;
    }
    for (const truth of gateCase.truthPairs) {
      if (truth.truthClass !== "separable") continue;
      const first = candidatesByStatement.get(truth.statementId)?.[0];
      if (!first) continue;
      gateRanking.separableFirstCandidateChecks += 1;
      if (first.receiptId === truth.receiptId) gateRanking.separableFirstCandidateHits += 1;
      if (statementResultById.get(truth.statementId)?.status !== "matched") {
        gateRanking.reviewSeparableFirstCandidateChecks += 1;
        if (first.receiptId === truth.receiptId) gateRanking.reviewSeparableFirstCandidateHits += 1;
      }
    }
  }

  const gateFinal = finalizeMetrics(gateTotals);
  const dedicatedCases = generateGateDedicatedCases();
  const dedicatedLegacyTotals = emptyLegacy();
  const dedicatedReports: Array<Record<string, unknown>> = [];
  for (const gateCase of dedicatedCases) {
    const outcome = runCase(gateCaseToGenerated(gateCase));
    if (!outcome.legacy) throw new Error(`dedicated gate case ${gateCase.id} did not produce legacy metrics`);
    addLegacy(dedicatedLegacyTotals, outcome.legacy);
    gateViolations.push(...outcome.violations);
    const candidateSets = new Map<string, string[]>();
    for (const candidate of outcome.result.candidates) {
      const list = candidateSets.get(candidate.statementTransactionId) ?? [];
      list.push(candidate.receiptId);
      candidateSets.set(candidate.statementTransactionId, list);
    }
    dedicatedReports.push({
      id: gateCase.id,
      candidateSets: [...candidateSets].sort(([left], [right]) => left.localeCompare(right)),
      candidateSetMismatchStatementCount: outcome.legacy.candidateSetMismatchStatementCount,
      candidateSetMissingCount: outcome.legacy.candidateSetMissingCount,
      candidateSetExtraCount: outcome.legacy.candidateSetExtraCount,
    });
  }
  const gateByFamilyReport: Record<string, GateFamilyReport> = {};
  let gateExpectedTotal = 0;
  let gateExpectedCorrectMet = true;
  let gateExpectedComplete = true;
  for (const family of GATE_FAMILIES) {
    const familyMetrics = gateByFamily.get(family);
    if (!familyMetrics) throw new Error(`gate family missing: ${family}`);
    const legacy = gateLegacyByFamily.get(family);
    if (!legacy) throw new Error(`gate legacy metrics missing: ${family}`);
    const expectedCorrect = GATE_EXPECTED_CORRECT[family];
    if (expectedCorrect === undefined) gateExpectedComplete = false;
    const expected = expectedCorrect ?? 0;
    gateExpectedTotal += expected;
    const expectedCorrectMet = familyMetrics.correctAutoMatchCount >= expected;
    if (!expectedCorrectMet) gateExpectedCorrectMet = false;
    gateByFamilyReport[family] = {
      ...finalizeMetrics(familyMetrics),
      ...legacy,
      expectedCorrect: expected,
      expectedCorrectMet,
    };
  }
  const gateChecks = {
    caseCountExact: gateCases.length === GATE_EXPECTED_CASE_COUNT,
    expectedComplete: gateExpectedComplete,
    expectedCorrectMet: gateExpectedCorrectMet && gateFinal.correctAutoMatchCount >= gateExpectedTotal,
    invalidZero: gateFinal.invalidAutoMatchCount === 0,
    newInvalidZero: gateLegacyTotals.newInvalidAutoMatchCount === 0,
    lostLegacyZero: gateLegacyTotals.lostLegacyAutoMatchCount === 0,
    invariantViolationsZero: gateViolations.length === 0,
    candidateSetMatches: gateLegacyTotals.candidateSetMismatchStatementCount === 0,
    dedicatedCandidateSetMatches: dedicatedLegacyTotals.candidateSetMismatchStatementCount === 0,
  };

  const report = {
    dataset: "eval/run-reconciliation-property.ts",
    generatorVersion: "1",
    seed: options.seed,
    ruleVersion: observedRuleVersionList.length === 0 ? null : observedRuleVersionList.join(", "),
    observedRuleVersions: observedRuleVersionList,
    config: {
      cases: options.cases,
      family: options.family,
      maxViolations: options.maxViolations,
      expectedRuleVersion: PINNED_RULE_VERSION,
    },
    metrics,
    byFamily: byFamilyReport,
    violationCount: violations.length,
    violationCounts: countViolations(violations),
    violations: violations.slice(0, options.maxViolations),
    indistinguishableCount: indistinguishable.length,
    indistinguishable: indistinguishable.slice(0, options.maxViolations),
    gate: {
      dataset: "eval/reconciliation-gate-dataset.ts",
      caseCount: gateCases.length,
      baseCaseCount: gateCases.length - robustnessCaseCount,
      robustnessCaseCount,
      seedsPerFamily: GATE_SEEDS,
      expectedCorrectTotal: gateExpectedTotal,
      expectedByFamily: GATE_EXPECTED_CORRECT,
      metrics: gateFinal,
      legacy: gateLegacyTotals,
      byFamily: gateByFamilyReport,
      checks: gateChecks,
      candidateSet: {
        checkedStatementCount: gateLegacyTotals.candidateSetCheckedStatementCount,
        mismatchStatementCount: gateLegacyTotals.candidateSetMismatchStatementCount,
        missingCount: gateLegacyTotals.candidateSetMissingCount,
        extraCount: gateLegacyTotals.candidateSetExtraCount,
        dedicated: {
          caseCount: dedicatedCases.length,
          cases: dedicatedReports,
          mismatchStatementCount: dedicatedLegacyTotals.candidateSetMismatchStatementCount,
          missingCount: dedicatedLegacyTotals.candidateSetMissingCount,
          extraCount: dedicatedLegacyTotals.candidateSetExtraCount,
        },
      },
      ranking: {
        ...gateRanking,
        assignedFirstRate: rankingRate(gateRanking.assignedFirstCount, gateRanking.assignmentCount),
        separableFirstCandidateRate: rankingRate(gateRanking.separableFirstCandidateHits, gateRanking.separableFirstCandidateChecks),
        reviewSeparableFirstCandidateRate: rankingRate(gateRanking.reviewSeparableFirstCandidateHits, gateRanking.reviewSeparableFirstCandidateChecks),
        truthPairsWithoutCandidates: gateFinal.truthPairsWithoutCandidates,
        candidateSetMismatchStatementCount: gateLegacyTotals.candidateSetMismatchStatementCount,
        candidateSetMissingCount: gateLegacyTotals.candidateSetMissingCount,
        candidateSetExtraCount: gateLegacyTotals.candidateSetExtraCount,
        autoDoubleMatchCount: gateFinal.doubleMatchCount,
        autoMatchSetDifferenceCount: gateLegacyTotals.lostLegacyAutoMatchCount + gateLegacyTotals.newInvalidAutoMatchCount,
      },
      violationCount: gateViolations.length,
      violationCounts: countViolations(gateViolations),
      violations: gateViolations.slice(0, options.maxViolations),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length > 0 || Object.values(gateChecks).some((passed) => !passed)) process.exitCode = 1;
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
