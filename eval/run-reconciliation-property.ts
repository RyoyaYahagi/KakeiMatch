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
  merchantAliasKey,
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAY = 86_400_000;
const DEFAULT_CASES = 1_200;
const DEFAULT_SEED = 376;
const PINNED_RULE_VERSION = "1.2.5";
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
type ReviewDateProfile = "off" | "1-2" | "3-7" | "5-10" | "8-14" | "15-21" | "22-30";

type SensitivityParameters = {
  normalDateMaxDays: number;
  reviewDateProfile: ReviewDateProfile;
  lowMerchantRatePercent: number;
  twinCaseRatePercent: number;
  allTruthPairsTwin: boolean;
};

const SENSITIVITY_BASELINE: SensitivityParameters = {
  normalDateMaxDays: 2,
  reviewDateProfile: "3-7",
  lowMerchantRatePercent: 0,
  twinCaseRatePercent: 10,
  allTruthPairsTwin: false,
};

const REVIEW_DATE_RANGES: Record<ReviewDateProfile, readonly [number, number] | null> = {
  off: null,
  "1-2": [1, 2],
  "3-7": [3, 7],
  "5-10": [5, 10],
  "8-14": [8, 14],
  "15-21": [15, 21],
  "22-30": [22, 30],
};

const FAMILIES: readonly Family[] = ["clean", "noise", "near-miss", "twin", "irreducible"];

type TruthPair = {
  statementId: string;
  receiptId: string;
  /** Class the generator intended to construct. */
  intent: TruthClass;
  /** Class recomputed from the generated records before assertions. */
  observedClass: TruthClass;
  currentAutoEligible?: boolean;
  lowMerchantRateSelected?: boolean;
  normalDateJitterDays?: number;
  reviewOnlyDateJitterDays?: number | null;
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
  sensitivity?: boolean;
};

type Options = {
  cases: number;
  seed: number;
  family: Family | null;
  maxViolations: number;
  gateOnly: boolean;
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
  candidateEligibleTruthPairCount: number;
  candidateEligibleRecallHitCount: number;
  candidateEligibleNoCandidateCount: number;
  candidateEligibleRecallMissCount: number;
  candidateOutsideDateWindowTruthPairCount: number;
  candidateOutsideAmountToleranceTruthPairCount: number;
  candidateOutsideBothTruthPairCount: number;
  candidateOutsideWindowNoCandidateCount: number;
  unconditionalTruthCandidateHitCount: number;
  currentRuleEligibleTruthPairCount: number;
  lowSimilarityTruthPairCount: number;
  safetyViolationCaseCount: number;
  safetyViolationCount: number;
  measurementIntegrityCaseCount: number;
  measurementIntegrityViolationCount: number;
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

function normalDateJitter(rng: () => number, maxDays: number): number {
  if (maxDays === 0 || rng() < 0.7) return 0;
  const totalWeight = (maxDays * (maxDays + 1)) / 2;
  let roll = rng() * totalWeight;
  let magnitude = maxDays;
  for (let days = 1; days <= maxDays; days += 1) {
    const weight = maxDays + 1 - days;
    if (roll < weight) {
      magnitude = days;
      break;
    }
    roll -= weight;
  }
  return magnitude * (rng() < 0.5 ? -1 : 1);
}

function reviewOnlyDateJitter(rng: () => number, profile: ReviewDateProfile): number {
  const range = REVIEW_DATE_RANGES[profile];
  if (!range) return 0;
  return int(rng, range[0], range[1]) * (rng() < 0.5 ? -1 : 1);
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
  { label: "corporate-form-prefix", statement: "株式会社青空食堂", receipt: "青空食堂", expectedSimilarity: 1, expectedEligible: true },
  { label: "corporate-form-suffix", statement: "青空食堂（株）", receipt: "青空食堂", expectedSimilarity: 1, expectedEligible: true },
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

function familyFor(index: number, twinCaseRatePercent: number): Family {
  const bucket = index % 100;
  const nonTwinPercent = 100 - twinCaseRatePercent;
  const cleanEnd = nonTwinPercent * 0.5;
  const noiseEnd = cleanEnd + nonTwinPercent / 3;
  const nearMissEnd = noiseEnd + nonTwinPercent / 9;
  const twinEnd = nearMissEnd + twinCaseRatePercent;
  if (bucket < cleanEnd) return "clean";
  if (bucket < noiseEnd) return "noise";
  if (bucket < nearMissEnd) return "near-miss";
  if (bucket < twinEnd) return "twin";
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

function generateCase(
  caseIndex: number,
  baseSeed: number,
  familyOverride: Family | null,
  sensitivity: SensitivityParameters = SENSITIVITY_BASELINE,
): GeneratedCase {
  const family = familyOverride ?? familyFor(caseIndex, sensitivity.twinCaseRatePercent);
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
      receipts.push(makeReceipt(id, receipt.merchant, receipt.amountYen, formatDay(dayNumber(statement.usedDate) + reviewOnlyDateJitter(rng, sensitivity.reviewDateProfile)), otherAccount(rng, receipt.actualAccountId)));
      return;
    }
    receipts.push(makeReceipt(id, pickLowCompetitorMerchant(rng, statement.merchant), receipt.amountYen, receipt.purchasedDate, otherAccount(rng, receipt.actualAccountId)));
  };

  const addTruthPair = (): void => {
    const receiptAmount = takeAmount();
    const receiptDay = startDay + int(rng, 0, 60);
    const account = pick(rng, ACCOUNTS);
    const lowMerchantRateSelected = rng() * 100 < sensitivity.lowMerchantRatePercent;
    let merchantPair = lowMerchantRateSelected
      ? pickLowMerchantPair(rng)
      : pickEligibleMerchantPair(rng);
    let statementAmount = receiptAmount;
    const normalJitter = normalDateJitter(rng, sensitivity.normalDateMaxDays);
    let statementDay = receiptDay + normalJitter;
    let reviewJitter: number | null = null;
    let intent: TruthClass = "separable";

    if (family === "noise") {
      const forceMode = !forcedNoiseAdded;
      forcedNoiseAdded = true;
      const roll = forceMode ? (caseIndex % 2 === 0 ? 0 : 1) : rng();
      if (roll < 0.1) {
        reviewJitter = reviewOnlyDateJitter(rng, sensitivity.reviewDateProfile);
        statementDay = receiptDay + reviewJitter;
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
        reviewJitter = reviewOnlyDateJitter(rng, sensitivity.reviewDateProfile);
        statementDay = receiptDay + reviewJitter;
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
    const truthPair: TruthPair = {
      statementId,
      receiptId,
      intent,
      observedClass: intent,
      lowMerchantRateSelected,
      normalDateJitterDays: normalJitter,
      reviewOnlyDateJitterDays: reviewJitter,
    };
    truthPairs.push(truthPair);

    if (family === "irreducible") {
      const decoyId = nextReceiptId();
      receipts.push(makeReceipt(decoyId, statement.merchant, statement.amountYen, statement.usedDate, otherAccount(rng, account)));
    }

    if (family === "twin" && (sensitivity.allTruthPairsTwin || !twinAdded || rng() < 0.3)) {
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
    sensitivity: sensitivity !== SENSITIVITY_BASELINE,
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

function currentRuleAutoEligible(
  statement: ReconciliationStatement,
  receipt: ReconciliationReceipt,
  statementAmountDayCounts: ReadonlyMap<string, number>,
  receiptAmountDayCounts: ReadonlyMap<string, number>,
  aliases?: ReadonlySet<string>,
): boolean {
  if (statement.kind !== "purchase") return false;
  const features = autoFeatures(statement, receipt);
  if (features.amountDeltaYen !== 0 || features.dateDistanceDays > PINNED_RULES.autoMatchDateWindowDays) return false;
  const aliasMatch = aliases?.has(merchantAliasKey(statement.merchant, receipt.merchant)) ?? false;
  if (aliasMatch || features.merchantSimilarity >= PINNED_RULES.autoMatchMerchantSimilarity) return true;
  const samePaymentSource = statement.preferredAccountIds?.includes(receipt.actualAccountId) ?? false;
  if (!samePaymentSource) return false;
  const statementDay = dayNumber(statement.usedDate);
  const receiptDay = dayNumber(receipt.purchasedDate);
  const countInWindow = (index: ReadonlyMap<string, number>, day: number, amount: number): number => {
    let count = 0;
    for (let offset = -PINNED_RULES.candidateDateWindowDays; offset <= PINNED_RULES.candidateDateWindowDays; offset += 1) {
      count += index.get(`${day + offset}:${amount}`) ?? 0;
    }
    return count;
  };
  const receiptExactAmountCount = countInWindow(receiptAmountDayCounts, statementDay, statement.amountYen);
  const statementExactAmountCount = countInWindow(statementAmountDayCounts, receiptDay, receipt.amountYen);
  return receiptExactAmountCount === 1 && statementExactAmountCount === 1;
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

const MEASUREMENT_INTEGRITY_KINDS = new Set([
  "statement_results_count_mismatch",
  "receipt_results_count_mismatch",
  "duplicate_statement_result_rows",
  "duplicate_receipt_result_rows",
  "statement_result_id_set_mismatch",
  "receipt_result_id_set_mismatch",
  "statement_result_missing",
  "receipt_result_missing",
  "truth_receipt_missing",
  "accounting_mismatch",
  "truth_statement_is_refund",
  "refund_kind_mismatch",
  "classification_mismatch",
]);

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
    candidateEligibleTruthPairCount: 0,
    candidateEligibleRecallHitCount: 0,
    candidateEligibleNoCandidateCount: 0,
    candidateEligibleRecallMissCount: 0,
    candidateOutsideDateWindowTruthPairCount: 0,
    candidateOutsideAmountToleranceTruthPairCount: 0,
    candidateOutsideBothTruthPairCount: 0,
    candidateOutsideWindowNoCandidateCount: 0,
    unconditionalTruthCandidateHitCount: 0,
    currentRuleEligibleTruthPairCount: 0,
    lowSimilarityTruthPairCount: 0,
    safetyViolationCaseCount: 0,
    safetyViolationCount: 0,
    measurementIntegrityCaseCount: 0,
    measurementIntegrityViolationCount: 0,
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

function runCase(generated: GeneratedCase, sensitivityMode = false): CaseOutcome {
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
  const statementAmountDayCounts = new Map<string, number>();
  const receiptAmountDayCounts = new Map<string, number>();
  if (sensitivityMode) {
    for (const statement of statements) {
      if (statement.kind !== "purchase") continue;
      const key = `${dayNumber(statement.usedDate)}:${statement.amountYen}`;
      statementAmountDayCounts.set(key, (statementAmountDayCounts.get(key) ?? 0) + 1);
    }
    for (const receipt of receipts) {
      const key = `${dayNumber(receipt.purchasedDate)}:${receipt.amountYen}`;
      receiptAmountDayCounts.set(key, (receiptAmountDayCounts.get(key) ?? 0) + 1);
    }
  }

  for (const truth of truthPairs) {
    if (generated.fixedTruthClass) {
      truth.observedClass = truth.intent;
      continue;
    }
    if (sensitivityMode) {
      // Preserve intent separately, while classifying this perturbation under
      // the current automatic feature gates. Declared twins remain ambiguous.
      const statement = statementById.get(truth.statementId)!;
      const receipt = receiptById.get(truth.receiptId)!;
      truth.currentAutoEligible = currentRuleAutoEligible(statement, receipt,
        statementAmountDayCounts, receiptAmountDayCounts, aliases);
      if (truth.intent === "ambiguous") truth.observedClass = "ambiguous";
      else if (!truth.currentAutoEligible) truth.observedClass = "unrecoverable";
      else {
        const hasEligibleCompetitor = receipts.some((candidate) => candidate.receiptId !== receipt.receiptId
          && currentRuleAutoEligible(statement, candidate, statementAmountDayCounts, receiptAmountDayCounts, aliases));
        truth.observedClass = hasEligibleCompetitor ? "ambiguous" : "separable";
      }
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
      const expectedNormalizationExpansion = generated.id.startsWith("dedicated-merchant-")
        || generated.id.startsWith("dedicated-corporate-");
      if (missing.length > 0 || (extra.length > 0 && !expectedNormalizationExpansion)) candidateSetMismatchStatementCount += 1;
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

    // Sensitivity distinguishes expected candidate-window rejection from
    // safety failures. The unconditional metric retains those misses.
    if (!hasTruthReceipt) continue;
    const truthReceipt = receiptById.get(truth.receiptId)!;
    const features = autoFeatures(statement, truthReceipt);
    const outsideDate = statement.kind !== "purchase" || features.dateDistanceDays > PINNED_RULES.candidateDateWindowDays;
    const allowedAmountDelta = Math.max(PINNED_RULES.amountToleranceAbsoluteYen,
      statement.amountYen * PINNED_RULES.amountToleranceRatio);
    const outsideAmount = features.amountDeltaYen > allowedAmountDelta;
    const ordinarilyAutoEligible = isAutoEligible(statement, truthReceipt);
    if (truth.currentAutoEligible ?? ordinarilyAutoEligible) metrics.currentRuleEligibleTruthPairCount += 1;
    if (features.merchantSimilarity < PINNED_RULES.autoMatchMerchantSimilarity) metrics.lowSimilarityTruthPairCount += 1;
    const truthCandidateHit = candidates.some((candidate) => candidate.receiptId === truth.receiptId && candidate.rank <= 3);
    if (truthCandidateHit) metrics.unconditionalTruthCandidateHitCount += 1;
    if (outsideDate && outsideAmount) metrics.candidateOutsideBothTruthPairCount += 1;
    else if (outsideDate) metrics.candidateOutsideDateWindowTruthPairCount += 1;
    else if (outsideAmount) metrics.candidateOutsideAmountToleranceTruthPairCount += 1;
    else {
      metrics.candidateEligibleTruthPairCount += 1;
      if (truthCandidateHit) metrics.candidateEligibleRecallHitCount += 1;
      if (candidates.length === 0) metrics.candidateEligibleNoCandidateCount += 1;
      if (!truthCandidateHit) metrics.candidateEligibleRecallMissCount += 1;
    }
    if ((outsideDate || outsideAmount) && candidates.length === 0) metrics.candidateOutsideWindowNoCandidateCount += 1;
    if (candidates.length === 0) {
      metrics.truthPairsWithoutCandidates += 1;
      if (!sensitivityMode || (!outsideDate && !outsideAmount)) {
        if (!sensitivityMode) addViolation("expected_review_candidate_missing", `${truth.statementId} (${truth.observedClass})`);
      }
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

  if (sensitivityMode) {
    const measurementIntegrityViolationCount = violations.filter((violation) => MEASUREMENT_INTEGRITY_KINDS.has(violation.kind)).length;
    const safetyViolationCount = violations.length - measurementIntegrityViolationCount;
    metrics.safetyViolationCount = safetyViolationCount;
    metrics.safetyViolationCaseCount = safetyViolationCount > 0 ? 1 : 0;
    metrics.measurementIntegrityViolationCount = measurementIntegrityViolationCount;
    metrics.measurementIntegrityCaseCount = measurementIntegrityViolationCount > 0 ? 1 : 0;
  }
  return { generated, metrics, violations, indistinguishable, ruleVersions, legacy, result };
}

type MetricEstimate = {
  numerator: number;
  denominator: number;
  value: number | null;
  status: "estimable" | "not_estimable";
};

type SensitivitySetting = {
  id: string;
  kind: "baseline" | "single-factor" | "pairwise" | "joint-stress" | "boundary-refine";
  parameters: SensitivityParameters;
  roles: string[];
};

type SensitivityRun = {
  settingId: string;
  kind: SensitivitySetting["kind"];
  parameters: SensitivityParameters;
  seed: number;
  caseCount: number;
  metrics: FinalMetrics;
  metricEstimates: Record<string, MetricEstimate>;
  candidateWindowClassification: {
    eligibleTruthPairs: number;
    eligibleTruthPairsWithoutCandidate: number;
    eligibleTruthRecallMisses: number;
    eligibleTruthRecallHits: number;
    outsideDateWindow: number;
    outsideAmountTolerance: number;
    outsideBoth: number;
    outsideWindowWithoutCandidate: number;
  };
  realizedNoise: {
    normalDateJitterDays: Record<string, number>;
    reviewOnlyDateJitterDays: Record<string, number>;
    finalTruthDateDistanceDays: Record<string, number>;
    generatedIntentClassCounts: Record<TruthClass, number>;
    lowSimilarityTruthPairs: number;
    lowSimilarityTruthPairRate: MetricEstimate;
    lowMerchantRateSelections: number;
    lowMerchantRateSelectionRate: MetricEstimate;
    generatedTwinTruthPairs: number;
    generatedTwinTruthPairRate: MetricEstimate;
    twinFamilyCaseCount: number;
  };
  byFamily: Record<string, FinalMetrics>;
  byFamilyMetricEstimates: Record<string, Record<string, MetricEstimate>>;
  safety: { violatingCaseCount: number; violationCount: number; violationCounts: Record<string, number> };
  measurementIntegrity: { invalidCaseCount: number; violationCount: number; violationCounts: Record<string, number> };
  violations: Violation[];
  indistinguishable: IndistinguishableMatch[];
};

function estimate(numerator: number, denominator: number): MetricEstimate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    status: denominator === 0 ? "not_estimable" : "estimable",
  };
}

function sensitivityEstimates(metrics: CaseMetrics): Record<string, MetricEstimate> {
  const invalidAutoMatches = metrics.falseAutoMatchCount + metrics.ambiguousAutoMatchCount
    + metrics.ineligibleTruthAutoMatchCount + metrics.unexplainedAutoMatchCount + metrics.matchWithoutTruthCount;
  return {
    autoMatchPrecision: estimate(metrics.correctAutoMatchCount, metrics.correctAutoMatchCount + invalidAutoMatches),
    autoMatchPrecisionAll: estimate(metrics.correctAutoMatchCount, metrics.autoMatchCount),
    eligibleTruthRecallAt3: estimate(metrics.candidateEligibleRecallHitCount, metrics.candidateEligibleTruthPairCount),
    unconditionalTruthCandidateCoverage: estimate(metrics.unconditionalTruthCandidateHitCount, metrics.truthPairCount),
    truthAutoMatchCoverage: estimate(metrics.correctAutoMatchCount, metrics.truthPairCount),
    currentRuleAutoEligibilityRate: estimate(metrics.currentRuleEligibleTruthPairCount, metrics.truthPairCount),
    ambiguousAbstentionRate: estimate(metrics.ambiguousAbstentionCount, metrics.ambiguousTruthPairCount),
    unrecoverableAbstentionRate: estimate(metrics.unrecoverableAbstentionCount, metrics.unrecoverableTruthPairCount),
  };
}

function runSensitivitySetting(setting: SensitivitySetting, seed: number, cases: number): SensitivityRun {
  const totals = emptyCaseMetrics();
  const byFamily = new Map<Family, CaseMetrics>();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  const dateDistanceHistogram: Record<string, number> = {};
  const normalJitterHistogram: Record<string, number> = {};
  const reviewJitterHistogram: Record<string, number> = {};
  let twinFamilyCaseCount = 0;
  let lowMerchantRateSelections = 0;
  const generatedIntentClassCounts: Record<TruthClass, number> = { separable: 0, ambiguous: 0, unrecoverable: 0 };
  for (let index = 0; index < cases; index += 1) {
    const generated = generateCase(index, seed, null, setting.parameters);
    if (generated.family === "twin") twinFamilyCaseCount += 1;
    const statementById = new Map(generated.statements.map((row) => [row.statementTransactionId, row]));
    const receiptById = new Map(generated.receipts.map((row) => [row.receiptId, row]));
    for (const truth of generated.truthPairs) {
      generatedIntentClassCounts[truth.intent] += 1;
      if (truth.lowMerchantRateSelected) lowMerchantRateSelections += 1;
      if (truth.normalDateJitterDays !== undefined) {
        const key = String(truth.normalDateJitterDays);
        normalJitterHistogram[key] = (normalJitterHistogram[key] ?? 0) + 1;
      }
      if (truth.reviewOnlyDateJitterDays !== undefined && truth.reviewOnlyDateJitterDays !== null) {
        const key = String(truth.reviewOnlyDateJitterDays);
        reviewJitterHistogram[key] = (reviewJitterHistogram[key] ?? 0) + 1;
      }
      const statement = statementById.get(truth.statementId)!;
      const receipt = receiptById.get(truth.receiptId)!;
      const distance = Math.abs(dayNumber(statement.usedDate) - dayNumber(receipt.purchasedDate));
      dateDistanceHistogram[String(distance)] = (dateDistanceHistogram[String(distance)] ?? 0) + 1;
    }
    const outcome = runCase(generated, true);
    addMetrics(totals, outcome.metrics);
    const family = generated.family as Family;
    const familyTotals = byFamily.get(family) ?? emptyCaseMetrics();
    addMetrics(familyTotals, outcome.metrics);
    byFamily.set(family, familyTotals);
    violations.push(...outcome.violations);
    indistinguishable.push(...outcome.indistinguishable);
  }
  const familyMetrics: Record<string, FinalMetrics> = {};
  const familyEstimates: Record<string, Record<string, MetricEstimate>> = {};
  for (const family of FAMILIES) {
    const metrics = byFamily.get(family);
    if (metrics) {
      familyMetrics[family] = finalizeMetrics(metrics);
      familyEstimates[family] = sensitivityEstimates(metrics);
    }
  }
  return {
    settingId: setting.id,
    kind: setting.kind,
    parameters: setting.parameters,
    seed,
    caseCount: cases,
    metrics: finalizeMetrics(totals),
    metricEstimates: sensitivityEstimates(totals),
    candidateWindowClassification: {
      eligibleTruthPairs: totals.candidateEligibleTruthPairCount,
      eligibleTruthPairsWithoutCandidate: totals.candidateEligibleNoCandidateCount,
      eligibleTruthRecallMisses: totals.candidateEligibleRecallMissCount,
      eligibleTruthRecallHits: totals.candidateEligibleRecallHitCount,
      outsideDateWindow: totals.candidateOutsideDateWindowTruthPairCount,
      outsideAmountTolerance: totals.candidateOutsideAmountToleranceTruthPairCount,
      outsideBoth: totals.candidateOutsideBothTruthPairCount,
      outsideWindowWithoutCandidate: totals.candidateOutsideWindowNoCandidateCount,
    },
    realizedNoise: {
      normalDateJitterDays: Object.fromEntries(Object.entries(normalJitterHistogram).sort(([left], [right]) => Number(left) - Number(right))),
      reviewOnlyDateJitterDays: Object.fromEntries(Object.entries(reviewJitterHistogram).sort(([left], [right]) => Number(left) - Number(right))),
      finalTruthDateDistanceDays: Object.fromEntries(Object.entries(dateDistanceHistogram).sort(([left], [right]) => Number(left) - Number(right))),
      generatedIntentClassCounts,
      lowSimilarityTruthPairs: totals.lowSimilarityTruthPairCount,
      lowSimilarityTruthPairRate: estimate(totals.lowSimilarityTruthPairCount, totals.truthPairCount),
      lowMerchantRateSelections,
      lowMerchantRateSelectionRate: estimate(lowMerchantRateSelections, totals.truthPairCount),
      generatedTwinTruthPairs: generatedIntentClassCounts.ambiguous,
      generatedTwinTruthPairRate: estimate(generatedIntentClassCounts.ambiguous, totals.truthPairCount),
      twinFamilyCaseCount,
    },
    byFamily: familyMetrics,
    byFamilyMetricEstimates: familyEstimates,
    safety: {
      violatingCaseCount: totals.safetyViolationCaseCount,
      violationCount: totals.safetyViolationCount,
      violationCounts: countViolations(violations.filter((violation) => !MEASUREMENT_INTEGRITY_KINDS.has(violation.kind))),
    },
    measurementIntegrity: {
      invalidCaseCount: totals.measurementIntegrityCaseCount,
      violationCount: totals.measurementIntegrityViolationCount,
      violationCounts: countViolations(violations.filter((violation) => MEASUREMENT_INTEGRITY_KINDS.has(violation.kind))),
    },
    violations,
    indistinguishable,
  };
}

function parameterKey(parameters: SensitivityParameters): string {
  return [parameters.normalDateMaxDays, parameters.reviewDateProfile, parameters.lowMerchantRatePercent,
    parameters.twinCaseRatePercent, Number(parameters.allTruthPairsTwin)].join("|");
}

function sensitivitySetting(
  id: string,
  kind: SensitivitySetting["kind"],
  overrides: Partial<SensitivityParameters> = {},
): SensitivitySetting {
  return { id, kind, parameters: { ...SENSITIVITY_BASELINE, ...overrides }, roles: [id] };
}

function buildSensitivitySettings(): { coarse: SensitivitySetting[]; fiveSeed: SensitivitySetting[]; endpoints: string[] } {
  const coarse: SensitivitySetting[] = [sensitivitySetting("baseline", "baseline")];
  for (const days of [0, 1, 3, 5, 7, 10, 14, 21, 30]) {
    coarse.push(sensitivitySetting(`single-date-${days}`, "single-factor", { normalDateMaxDays: days }));
  }
  for (const profile of ["off", "1-2", "5-10", "8-14", "15-21", "22-30"] as const) {
    coarse.push(sensitivitySetting(`single-review-${profile}`, "single-factor", { reviewDateProfile: profile }));
  }
  for (const percent of [5, 10, 20, 40, 60, 80, 100]) {
    coarse.push(sensitivitySetting(`single-low-merchant-${percent}`, "single-factor", { lowMerchantRatePercent: percent }));
  }
  for (const percent of [0, 1, 5, 20, 40, 70, 100]) {
    coarse.push(sensitivitySetting(`single-twin-${percent}`, "single-factor", { twinCaseRatePercent: percent }));
  }
  coarse.push(sensitivitySetting("joint-extreme", "joint-stress", {
    normalDateMaxDays: 30,
    reviewDateProfile: "22-30",
    lowMerchantRatePercent: 100,
    twinCaseRatePercent: 100,
    allTruthPairsTwin: true,
  }));

  const pairwise: SensitivitySetting[] = [];
  const dateLevels = [3, 7] as const;
  const reviewLevels = ["5-10", "8-14"] as const;
  const lowLevels = [20, 60] as const;
  const twinLevels = [20, 70] as const;
  const pair = (name: string, left: readonly unknown[], right: readonly unknown[], leftKey: keyof SensitivityParameters,
    rightKey: keyof SensitivityParameters) => {
    for (const a of left) for (const b of right) {
      pairwise.push(sensitivitySetting(`pair-${name}-${String(a)}-${String(b)}`, "pairwise", {
        [leftKey]: a,
        [rightKey]: b,
      }));
    }
  };
  pair("date-review", dateLevels, reviewLevels, "normalDateMaxDays", "reviewDateProfile");
  pair("date-low", dateLevels, lowLevels, "normalDateMaxDays", "lowMerchantRatePercent");
  pair("date-twin", dateLevels, twinLevels, "normalDateMaxDays", "twinCaseRatePercent");
  pair("review-low", reviewLevels, lowLevels, "reviewDateProfile", "lowMerchantRatePercent");
  pair("review-twin", reviewLevels, twinLevels, "reviewDateProfile", "twinCaseRatePercent");
  pair("low-twin", lowLevels, twinLevels, "lowMerchantRatePercent", "twinCaseRatePercent");
  coarse.push(...pairwise);
  if (coarse.length !== 55) throw new Error(`sensitivity design expected 55 settings, got ${coarse.length}`);

  const endpointSettings = [
    coarse.find((item) => item.id === "single-date-0")!,
    coarse.find((item) => item.id === "single-date-30")!,
    coarse.find((item) => item.id === "single-review-off")!,
    coarse.find((item) => item.id === "single-review-22-30")!,
    coarse.find((item) => item.id === "baseline")!, // q=0 and twin=10 share the baseline setting.
    coarse.find((item) => item.id === "single-low-merchant-100")!,
    coarse.find((item) => item.id === "single-twin-0")!,
    coarse.find((item) => item.id === "single-twin-100")!,
    coarse.find((item) => item.id === "joint-extreme")!,
  ];
  const controls = [
    ...dateLevels.map((value) => coarse.find((item) => item.id === `single-date-${value}`)!),
    ...reviewLevels.map((value) => coarse.find((item) => item.id === `single-review-${value}`)!),
    ...lowLevels.map((value) => coarse.find((item) => item.id === `single-low-merchant-${value}`)!),
    ...twinLevels.map((value) => coarse.find((item) => item.id === `single-twin-${value}`)!),
  ];
  const distinct = new Map<string, SensitivitySetting>();
  for (const setting of [...endpointSettings, ...controls, ...pairwise]) {
    const key = parameterKey(setting.parameters);
    const prior = distinct.get(key);
    if (prior) prior.roles.push(setting.id);
    else distinct.set(key, { ...setting, roles: [...setting.roles] });
  }
  if (distinct.size !== 41) throw new Error(`sensitivity multi-seed design expected 41 unique settings, got ${distinct.size}`);
  return { coarse, fiveSeed: [...distinct.values()], endpoints: endpointSettings.map((setting) => setting.id) };
}

function classifySensitivityRun(run: SensitivityRun, fixedGatePassed: boolean): "held_observed" | "broken_observed" | "inconclusive" {
  const precision = run.metricEstimates.autoMatchPrecision;
  const recall = run.metricEstimates.eligibleTruthRecallAt3;
  if (run.measurementIntegrity.violationCount > 0) return "inconclusive";
  if (run.safety.violationCount > 0 || !fixedGatePassed
    || (precision.value !== null && precision.value < 1)
    || (recall.value !== null && recall.value < 1)) return "broken_observed";
  if (precision.status === "not_estimable" || recall.status === "not_estimable") return "inconclusive";
  return "held_observed";
}

function getSensitivityRun(runs: Map<string, SensitivityRun>, parameters: SensitivityParameters, seed: number): SensitivityRun | undefined {
  return runs.get(`${parameterKey(parameters)}@${seed}`);
}

function putSensitivityRun(runs: Map<string, SensitivityRun>, run: SensitivityRun): void {
  runs.set(`${parameterKey(run.parameters)}@${run.seed}`, run);
}

function buildSensitivityBoundaries(
  settings: readonly SensitivitySetting[],
  runs: Map<string, SensitivityRun>,
  fixedGatePassed: boolean,
): { factors: Record<string, unknown>; refine: SensitivitySetting[] } {
  const settingByKey = new Map(settings.map((setting) => [parameterKey(setting.parameters), setting]));
  const factorLevels: Array<{ factor: string; values: Array<string | number>; parameter: keyof SensitivityParameters }> = [
    { factor: "normalDateMaxDays", values: [0, 1, 2, 3, 5, 7, 10, 14, 21, 30], parameter: "normalDateMaxDays" },
    { factor: "reviewDateProfile", values: ["off", "1-2", "3-7", "5-10", "8-14", "15-21", "22-30"], parameter: "reviewDateProfile" },
    { factor: "lowMerchantRatePercent", values: [0, 5, 10, 20, 40, 60, 80, 100], parameter: "lowMerchantRatePercent" },
    { factor: "twinCaseRatePercent", values: [0, 1, 5, 10, 20, 40, 70, 100], parameter: "twinCaseRatePercent" },
  ];
  const refine: SensitivitySetting[] = [];
  const factors: Record<string, unknown> = {};
  for (const spec of factorLevels) {
    const points = spec.values.map((value) => {
      const parameters = { ...SENSITIVITY_BASELINE, [spec.parameter]: value } as SensitivityParameters;
      const run = getSensitivityRun(runs, parameters, DEFAULT_SEED);
      if (!run) throw new Error(`missing seed-376 coarse setting for ${spec.factor}=${String(value)}`);
      return { value, run, status: classifySensitivityRun(run, fixedGatePassed) };
    });
    const transitions: Array<{ from: string | number; to: string | number; fromStatus: string; toStatus: string }> = [];
    for (let index = 1; index < points.length; index += 1) {
      const before = points[index - 1]!;
      const after = points[index]!;
      if (before.status === "held_observed" && after.status !== "held_observed") {
        transitions.push({ from: before.value, to: after.value, fromStatus: before.status, toStatus: after.status });
      }
    }
    const firstTransition = transitions[0];
    const refinedValues: Array<string | number> = [];
    if (firstTransition && spec.factor !== "reviewDateProfile") {
      const left = Number(firstTransition.from);
      const right = Number(firstTransition.to);
      for (let value = left + 1; value < right; value += 1) refinedValues.push(value);
      for (const value of refinedValues) {
        const parameters = { ...SENSITIVITY_BASELINE, [spec.parameter]: value } as SensitivityParameters;
        const key = parameterKey(parameters);
        const existing = settingByKey.get(key);
        if (existing) continue;
        const setting = sensitivitySetting(`boundary-${spec.factor}-${value}`, "boundary-refine", { [spec.parameter]: value } as Partial<SensitivityParameters>);
        settingByKey.set(key, setting);
        refine.push(setting);
      }
    }
    factors[spec.factor] = {
      orderedLevels: points.map(({ value, status, run }) => ({
        value,
        status,
        safetyViolationCount: run.safety.violationCount,
        knownPrecision: run.metricEstimates.autoMatchPrecision,
        eligibleTruthRecallAt3: run.metricEstimates.eligibleTruthRecallAt3,
        unconditionalTruthCandidateCoverage: run.metricEstimates.unconditionalTruthCandidateCoverage,
      })),
      heldRange: points.filter((point) => point.status === "held_observed").map((point) => point.value),
      transitions,
      firstTransition,
      refinedValues,
      nonMonotonic: transitions.length > 1,
      upperRangeStatus: points.at(-1)?.status,
    };
  }
  return { factors, refine };
}

function runFixedGateOnce(): Record<string, unknown> {
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", script,
    "--gate-only", "--max-violations=100000"], { encoding: "utf8" });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`fixed gate process failed (${child.status}): ${child.stderr.slice(-4000)}`);
  const report = JSON.parse(child.stdout) as { gate: Record<string, unknown>; generatorVersion: string; ruleVersion: string };
  return {
    dataset: "eval/reconciliation-gate-dataset.ts",
    caseCount: 1_700,
    executionCount: 1,
    generatorVersion: report.generatorVersion,
    ruleVersion: report.ruleVersion,
    ...report.gate,
  };
}

function mainSensitivityBatch(): void {
  checkRuleContract();
  const smoke = process.argv.includes("--sensitivity-smoke");
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const cases = smoke ? 10 : 1_200;
  const seeds = smoke ? [376] : [376, 1376, 2376, 3376, 4376];
  const extraSeeds = smoke ? [] : [5376, 6376, 7376, 8376, 9376];
  const { coarse, fiveSeed, endpoints } = buildSensitivitySettings();
  const runs = new Map<string, SensitivityRun>();
  const runSetting = (setting: SensitivitySetting, seed: number) => {
    const key = `${parameterKey(setting.parameters)}@${seed}`;
    if (runs.has(key)) return;
    const t0 = Date.now();
    const run = runSensitivitySetting(setting, seed, cases);
    (run as SensitivityRun & { elapsedMs?: number }).elapsedMs = Date.now() - t0;
    putSensitivityRun(runs, run);
    process.stderr.write(`sensitivity ${runs.size}: ${setting.id} seed=${seed} elapsedMs=${(run as SensitivityRun & { elapsedMs: number }).elapsedMs}\n`);
  };

  for (const setting of coarse) runSetting(setting, DEFAULT_SEED);
  const fixedGate = runFixedGateOnce();
  const fixedGatePassed = Object.values(fixedGate.checks as Record<string, boolean>).every(Boolean);
  const firstBoundaryScan = buildSensitivityBoundaries(coarse, runs, fixedGatePassed);
  for (const setting of firstBoundaryScan.refine) runSetting(setting, DEFAULT_SEED);

  // Add the declared endpoint, pairwise, singleton-control, and baseline seeds.
  for (const setting of fiveSeed) for (const seed of seeds) runSetting(setting, seed);

  const boundaryRows: Array<Record<string, unknown>> = [];
  const factorParameters: Record<string, keyof SensitivityParameters> = {
    normalDateMaxDays: "normalDateMaxDays",
    reviewDateProfile: "reviewDateProfile",
    lowMerchantRatePercent: "lowMerchantRatePercent",
    twinCaseRatePercent: "twinCaseRatePercent",
  };
  for (const [factor, parameter] of Object.entries(factorParameters)) {
    const factorData = firstBoundaryScan.factors[factor] as { firstTransition?: { from: string | number; to: string | number } | null };
    if (!factorData.firstTransition) {
      boundaryRows.push({ factor, status: "no_held_to_nonheld_transition_in_coarse_scan" });
      continue;
    }
    const from = { ...SENSITIVITY_BASELINE, [parameter]: factorData.firstTransition.from } as SensitivityParameters;
    const to = { ...SENSITIVITY_BASELINE, [parameter]: factorData.firstTransition.to } as SensitivityParameters;
    const leftRun = getSensitivityRun(runs, from, DEFAULT_SEED)!;
    const rightRun = getSensitivityRun(runs, to, DEFAULT_SEED)!;
    const refinedBetween = [...firstBoundaryScan.refine]
      .filter((setting) => parameterKey(setting.parameters) !== parameterKey(from)
        && parameterKey(setting.parameters) !== parameterKey(to)
        && (parameter === "reviewDateProfile"
          ? false
          : Number(setting.parameters[parameter] as number) > Number(from[parameter] as number)
            && Number(setting.parameters[parameter] as number) < Number(to[parameter] as number)))
      .sort((a, b) => Number(a.parameters[parameter] as number) - Number(b.parameters[parameter] as number));
    const ordered = [
      { setting: sensitivitySetting(`boundary-anchor-${factor}-from`, "boundary-refine", { [parameter]: from[parameter] } as Partial<SensitivityParameters>), run: leftRun },
      ...refinedBetween.map((setting) => ({ setting, run: getSensitivityRun(runs, setting.parameters, DEFAULT_SEED)! })),
      { setting: sensitivitySetting(`boundary-anchor-${factor}-to`, "boundary-refine", { [parameter]: to[parameter] } as Partial<SensitivityParameters>), run: rightRun },
    ];
    let lastHeld = ordered[0]!;
    let firstNonHeld = ordered.at(-1)!;
    for (const point of ordered) {
      const status = classifySensitivityRun(point.run, fixedGatePassed);
      if (status === "held_observed") lastHeld = point;
      else {
        firstNonHeld = point;
        break;
      }
    }
    const boundarySettings = [lastHeld.setting, firstNonHeld.setting];
    for (const setting of boundarySettings) for (const seed of seeds) runSetting(setting, seed);
    const fiveStatuses = boundarySettings.map((setting) => ({
      settingId: setting.id,
      seedStatuses: seeds.map((seed) => ({
        seed,
        status: classifySensitivityRun(getSensitivityRun(runs, setting.parameters, seed)!, fixedGatePassed),
      })),
    }));
    const mixed = fiveStatuses.some((entry) => new Set(entry.seedStatuses.map((item) => item.status)).size > 1);
    if (mixed) {
      for (const setting of boundarySettings) for (const seed of extraSeeds) runSetting(setting, seed);
    }
    const allBoundarySeeds = mixed ? [...seeds, ...extraSeeds] : seeds;
    boundaryRows.push({
      factor,
      status: mixed ? `expanded_to_${seeds.length + extraSeeds.length}_seeds` : `confirmed_on_${seeds.length}_seeds`,
      lastHeldSetting: lastHeld.setting.id,
      firstNonHeldSetting: firstNonHeld.setting.id,
      seedStatuses: boundarySettings.map((setting) => ({
        settingId: setting.id,
        statuses: allBoundarySeeds.map((seed) => ({
          seed,
          status: classifySensitivityRun(getSensitivityRun(runs, setting.parameters, seed)!, fixedGatePassed),
        })),
      })),
      unstableBoundaryInterval: mixed,
    });
  }

  const pairwiseNames = ["date-review", "date-low", "date-twin", "review-low", "review-twin", "low-twin"] as const;
  const pairwise = pairwiseNames.map((name) => {
    const group = coarse.filter((setting) => setting.kind === "pairwise" && setting.id.startsWith(`pair-${name}-`));
    const cells = group.map((setting) => ({
      settingId: setting.id,
      parameters: setting.parameters,
      bySeed: seeds.map((seed) => {
        const run = getSensitivityRun(runs, setting.parameters, seed)!;
        const singletonA = sensitivitySingleton(name, setting.parameters, "A", coarse);
        const singletonB = sensitivitySingleton(name, setting.parameters, "B", coarse);
        const metric = (key: string) => run.metricEstimates[key]?.value ?? null;
        const base = getSensitivityRun(runs, SENSITIVITY_BASELINE, seed)!;
        const aRun = getSensitivityRun(runs, singletonA.parameters, seed)!;
        const bRun = getSensitivityRun(runs, singletonB.parameters, seed)!;
        const did = (metricKey: string): number | null => {
          const vals = [metric(metricKey), aRun.metricEstimates[metricKey]?.value ?? null,
            bRun.metricEstimates[metricKey]?.value ?? null, base.metricEstimates[metricKey]?.value ?? null];
          if (vals.some((value) => value === null)) return null;
          return vals[0]! - vals[1]! - vals[2]! + vals[3]!;
        };
        const comboUnsafe = run.safety.violationCount > 0;
        const singleAUnsafe = aRun.safety.violationCount > 0;
        const singleBUnsafe = bRun.safety.violationCount > 0;
        return {
          seed,
          status: classifySensitivityRun(run, fixedGatePassed),
          differenceInDifferences: {
            truthAutoMatchCoverage: did("truthAutoMatchCoverage"),
            eligibleTruthRecallAt3: did("eligibleTruthRecallAt3"),
          },
          safetyCombinationOnly: comboUnsafe && !singleAUnsafe && !singleBUnsafe,
          safetyViolationCount: run.safety.violationCount,
        };
      }),
    }));
    return { factorPair: name, cells };
  });

  const runRows = [...runs.values()].sort((left, right) => compareText(left.settingId, right.settingId) || left.seed - right.seed);
  const summaryBySetting = coarse.map((setting) => {
    const rows = seeds.map((seed) => getSensitivityRun(runs, setting.parameters, seed)).filter((run): run is SensitivityRun => Boolean(run));
    const seed376 = getSensitivityRun(runs, setting.parameters, DEFAULT_SEED)!;
    return {
      id: setting.id,
      kind: setting.kind,
      roles: setting.roles,
      parameters: setting.parameters,
      seedStatuses: rows.map((run) => ({ seed: run.seed, status: classifySensitivityRun(run, fixedGatePassed) })),
      seed376Metrics: seed376.metricEstimates,
      seed376CandidateWindowClassification: seed376.candidateWindowClassification,
      seed376Safety: seed376.safety,
      seed376NotEstimable: Object.entries(seed376.metricEstimates).filter(([, metric]) => metric.status === "not_estimable").map(([key]) => key),
    };
  });
  const totalPropertyCases = runRows.reduce((sum, run) => sum + run.caseCount, 0);
  const report = {
    schemaVersion: 2,
    generatorVersion: "2",
    ruleVersion: PINNED_RULE_VERSION,
    evaluationSourceCommitSHA: gitOutput(["rev-parse", "HEAD"]),
    resultsCommitSHA: null as string | null,
    generatedAt: startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startMs,
    environment: {
      nodeVersion: process.version,
      pnpmVersion: commandOutput("pnpm", ["--version"]),
      packageManager: "pnpm@10.15.0",
      prng: "mulberry32",
      caseSeedFormula: "(masterSeed + imul(caseIndex + 1, 0x9e3779b1)) >>> 0",
      command: "pnpm eval:reconciliation-property:sensitivity",
      casesPerSettingSeed: cases,
      masterSeeds: seeds,
      additionalSeedsIfBoundaryMixed: extraSeeds,
      smokeMode: smoke,
    },
    design: {
      coarseSettingCount: coarse.length,
      coarseSettings: coarse.map((setting) => ({ id: setting.id, kind: setting.kind, roles: setting.roles, parameters: setting.parameters })),
      fiveSeedSettingIds: fiveSeed.map((setting) => ({ id: setting.id, roles: setting.roles, parameters: setting.parameters })),
      endpointSettingIds: endpoints,
      boundaryRefinementSettingIds: firstBoundaryScan.refine.map((setting) => setting.id),
      stopRules: {
        firstHeldToNonHeldTransitionPerFactorRefined: true,
        normalDateStepDays: 1,
        lowMerchantAndTwinStepPercentagePoints: 1,
        reviewDateProfilesAreCategorical: true,
        seedsPerBoundaryPoint: 5,
        maxSeedsIfMixed: seeds.length + extraSeeds.length === 1 ? 1 : 10,
        mixedAtTenSeedsReportedAsUnstableAndStopped: true,
        noPopulationGuaranteeFromZeroObservedViolations: true,
      },
    },
    fixedGate,
    totals: {
      uniqueSettingSeedRuns: runRows.length,
      propertyCases: totalPropertyCases,
      fixedGateExecutions: 1,
      fixedGateCases: 1_700,
      totalEngineEvaluatedCases: totalPropertyCases + 1_700,
      propertyCaseSeedRuns: runRows.length,
      boundaryExtraSeedRuns: runRows.filter((run) => extraSeeds.includes(run.seed)).length,
    },
    baselineV2: summaryBySetting.find((setting) => setting.id === "baseline"),
    coarseSummary: summaryBySetting,
    factorSensitivity: firstBoundaryScan.factors,
    refinedBoundaryConfirmation: boundaryRows,
    pairwiseInteractions: pairwise,
    runs: runRows,
  };
  console.log(JSON.stringify(report, null, 2));
}

function sensitivitySingleton(name: string, parameters: SensitivityParameters, side: "A" | "B", settings: readonly SensitivitySetting[]): SensitivitySetting {
  const factorNames: Record<string, [keyof SensitivityParameters, keyof SensitivityParameters]> = {
    "date-review": ["normalDateMaxDays", "reviewDateProfile"],
    "date-low": ["normalDateMaxDays", "lowMerchantRatePercent"],
    "date-twin": ["normalDateMaxDays", "twinCaseRatePercent"],
    "review-low": ["reviewDateProfile", "lowMerchantRatePercent"],
    "review-twin": ["reviewDateProfile", "twinCaseRatePercent"],
    "low-twin": ["lowMerchantRatePercent", "twinCaseRatePercent"],
  };
  const key = factorNames[name]?.[side === "A" ? 0 : 1];
  if (!key) throw new Error(`unknown pairwise factor ${name}`);
  const overrides = { [key]: parameters[key] } as Partial<SensitivityParameters>;
  const expected = { ...SENSITIVITY_BASELINE, ...overrides };
  const setting = settings.find((item) => item.kind === "single-factor" && parameterKey(item.parameters) === parameterKey(expected));
  if (!setting) throw new Error(`missing ${side} singleton control for ${name}`);
  return setting;
}

function gitOutput(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return "unavailable";
  return result.stdout.trim();
}

// ---------- CLI, contract, and report ----------

function parseOptions(argv: readonly string[]): Options | null {
  let cases = DEFAULT_CASES;
  let seed = DEFAULT_SEED;
  let family: Family | null = null;
  let maxViolations = 50;
  let gateOnly = false;
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.error("Usage: pnpm eval:reconciliation-property -- [--cases=1200] [--seed=376] [--family=clean|noise|near-miss|twin|irreducible] [--max-violations=50] [--gate-only]");
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
    if (argument === "--gate-only") {
      gateOnly = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(cases) || (gateOnly ? cases < 0 : cases <= 0)) throw new Error("--cases must be a positive integer");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("--seed must be a 32-bit unsigned integer");
  if (!Number.isInteger(maxViolations) || maxViolations < 0) throw new Error("--max-violations must be a non-negative integer");
  return { cases, seed, family, maxViolations, gateOnly };
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
  if (process.argv.includes("--sensitivity-batch")) {
    mainSensitivityBatch();
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  checkRuleContract();

  const totals = emptyCaseMetrics();
  const byFamily = new Map<Family, CaseMetrics>();
  const violations: Violation[] = [];
  const indistinguishable: IndistinguishableMatch[] = [];
  const observedRuleVersions = new Set<string>();
  if (!options.gateOnly) {
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
    if (gateCase.id.startsWith("dedicated-merchant-") || gateCase.id.startsWith("dedicated-corporate-")) {
      const truth = gateCase.truthPairs[0];
      const result = outcome.result.statementResults.find((row) => row.statementTransactionId === truth?.statementId);
      if (result?.status !== "matched" || result.matchedReceiptId !== truth?.receiptId) {
        gateViolations.push({ seed: gateCase.seed, caseId: gateCase.id, family: gateCase.family,
          kind: "merchant_normalization_not_auto_matched", detail: `${truth?.statementId} -> ${truth?.receiptId}` });
      }
    }
    const candidateSets = new Map<string, string[]>();
    for (const candidate of outcome.result.candidates) {
      const list = candidateSets.get(candidate.statementTransactionId) ?? [];
      list.push(candidate.receiptId);
      candidateSets.set(candidate.statementTransactionId, list);
    }
    dedicatedReports.push({
      id: gateCase.id,
      autoMatchCount: outcome.metrics.autoMatchCount,
      correctAutoMatchCount: outcome.metrics.correctAutoMatchCount,
      falseAutoMatchCount: outcome.metrics.falseAutoMatchCount,
      lostLegacyAutoMatchCount: outcome.legacy.lostLegacyAutoMatchCount,
      newInvalidAutoMatchCount: outcome.legacy.newInvalidAutoMatchCount,
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
    generatorVersion: "2",
    seed: options.seed,
    ruleVersion: observedRuleVersionList.length === 0
      ? (options.gateOnly ? PINNED_RULE_VERSION : null)
      : observedRuleVersionList.join(", "),
    observedRuleVersions: observedRuleVersionList,
    config: {
      cases: options.gateOnly ? 0 : options.cases,
      gateOnly: options.gateOnly,
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
