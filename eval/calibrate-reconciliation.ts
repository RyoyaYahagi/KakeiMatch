import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconciliationFSFeatures,
  reconciliationFSScore,
  RECONCILIATION_FS_CATEGORIES,
  type ReconciliationFSCategory,
  type ReconciliationFSWeights,
} from "../src/lib/reconciliation-fs";
import {
  reconciliationMerchantSimilarity,
  runReconciliationEngineForFSCalibration,
  RECONCILIATION_RULES,
  type ReconciliationFSEvaluation,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";
import { merchantAliasKey } from "../src/lib/reconciliation-engine";

const ALPHA = 1;
const WEIGHT_CAP_NATS = 4;
const FALSE_AUTO_CASE_RATE_TARGET = 0.005;
const ONE_SIDED_CONFIDENCE = 0.95;
const SPLIT_MODULUS = 2;
const SPLIT_VALIDATION_REMAINDER = 0;
const NO_AUTO_THRESHOLD = 1_000_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "eval/reconciliation-fs-calibration.json");

type CalibrationCase = {
  id: string;
  seedGroup: string;
  family: string;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases?: ReadonlySet<string>;
  truthPairs: Array<{ statementId: string; receiptId: string; eligible: boolean }>;
};
type Pair = {
  key: string;
  features: ReconciliationFSCategory[];
  waiver: boolean;
  autoGateEligible: boolean;
  eligibleTruth: boolean;
  isTruth: boolean;
  score: number;
};
type PairCounts = Record<ReconciliationFSCategory, number>;
type Counts = { m: PairCounts; u: PairCounts; mTotal: PairCounts; uTotal: PairCounts };

function emptyCounts(): Counts {
  const make = () => Object.fromEntries(RECONCILIATION_FS_CATEGORIES.map((key) => [key, 0])) as PairCounts;
  return { m: make(), u: make(), mTotal: make(), uTotal: make() };
}

function seedNumber(seedGroup: string): number {
  const value = Number(seedGroup.slice(seedGroup.indexOf(":") + 1));
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid seed group: ${seedGroup}`);
  return value;
}

function splitFor(seedGroup: string): "train" | "validation" {
  return seedNumber(seedGroup) % SPLIT_MODULUS === SPLIT_VALIDATION_REMAINDER ? "validation" : "train";
}

function pairData(item: CalibrationCase): Pair[] {
  const truth = new Map(item.truthPairs.map((pair) => [`${pair.statementId}\0${pair.receiptId}`, pair]));
  const receiptCounts = new Map<number, Map<number, number>>();
  const statementCounts = new Map<number, Map<number, number>>();
  for (const receipt of item.receipts) {
    const day = Date.parse(`${receipt.purchasedDate}T00:00:00.000Z`) / 86_400_000;
    const amounts = receiptCounts.get(day) ?? new Map<number, number>();
    amounts.set(receipt.amountYen, (amounts.get(receipt.amountYen) ?? 0) + 1);
    receiptCounts.set(day, amounts);
  }
  for (const statement of item.statements) {
    if (statement.kind !== "purchase") continue;
    const day = Date.parse(`${statement.usedDate}T00:00:00.000Z`) / 86_400_000;
    const amounts = statementCounts.get(day) ?? new Map<number, number>();
    amounts.set(statement.amountYen, (amounts.get(statement.amountYen) ?? 0) + 1);
    statementCounts.set(day, amounts);
  }
  const exactCount = (counts: Map<number, Map<number, number>>, day: number, amount: number) => {
    let count = 0;
    for (let offset = -RECONCILIATION_RULES.candidateDateWindowDays; offset <= RECONCILIATION_RULES.candidateDateWindowDays; offset += 1) {
      count += counts.get(day + offset)?.get(amount) ?? 0;
    }
    return count;
  };
  const result: Pair[] = [];
  for (const statement of item.statements) {
    if (statement.kind !== "purchase") continue;
    const sDay = Date.parse(`${statement.usedDate}T00:00:00.000Z`);
    for (const receipt of item.receipts) {
      const rDay = Date.parse(`${receipt.purchasedDate}T00:00:00.000Z`);
      const days = Math.abs(sDay - rDay) / 86_400_000;
      const delta = Math.abs(statement.amountYen - receipt.amountYen);
      const tolerance = Math.max(RECONCILIATION_RULES.amountToleranceAbsoluteYen, statement.amountYen * RECONCILIATION_RULES.amountToleranceRatio);
      if (days > RECONCILIATION_RULES.candidateDateWindowDays || delta > tolerance) continue;
      const sameSource = statement.preferredAccountIds?.includes(receipt.actualAccountId) ?? false;
      const sourceKnown = (statement.preferredAccountIds?.length ?? 0) > 0;
      const unique = delta === 0
        && exactCount(receiptCounts, sDay / 86_400_000, statement.amountYen) === 1
        && exactCount(statementCounts, rDay / 86_400_000, receipt.amountYen) === 1;
      const waiver = sameSource && unique;
      const aliasMatch = item.aliases?.has(merchantAliasKey(statement.merchant, receipt.merchant)) ?? false;
      const merchantSimilarity = reconciliationMerchantSimilarity(statement.merchant, receipt.merchant);
      const features = reconciliationFSFeatures({ amountDeltaYen: delta, amountToleranceYen: tolerance, dateDistanceDays: days,
        merchantSimilarity, samePaymentSource: sameSource, paymentSourceKnown: sourceKnown, aliasMatch, waiver });
      const truthPair = truth.get(`${statement.statementTransactionId}\0${receipt.receiptId}`);
      result.push({ key: `${statement.statementTransactionId}\0${receipt.receiptId}`, features, waiver,
        autoGateEligible: delta === 0 && days <= RECONCILIATION_RULES.autoMatchDateWindowDays
          && (waiver || aliasMatch || merchantSimilarity >= RECONCILIATION_RULES.autoMatchMerchantSimilarity),
        eligibleTruth: truthPair?.eligible ?? false, isTruth: truthPair !== undefined, score: 0 });
    }
  }
  return result;
}

function countFeatures(counts: Counts, pair: Pair, className: "m" | "u"): void {
  for (const key of pair.features) {
    counts[className][key] += 1;
    counts[`${className}Total`][key] += 1;
  }
}

function fitCategoryWeights(counts: Counts): ReconciliationFSWeights {
  const weights = {} as ReconciliationFSWeights;
  for (const field of ["amount", "date", "merchant", "source"] as const) {
    const categories = RECONCILIATION_FS_CATEGORIES.filter((key) => key.startsWith(`${field}:`));
    const mN = categories.reduce((sum, key) => sum + counts.mTotal[key], 0);
    const uN = categories.reduce((sum, key) => sum + counts.uTotal[key], 0);
    for (const key of categories) {
      const m = (counts.m[key] + ALPHA) / (mN + ALPHA * categories.length);
      const u = (counts.u[key] + ALPHA) / (uN + ALPHA * categories.length);
      weights[key] = Math.max(-WEIGHT_CAP_NATS, Math.min(WEIGHT_CAP_NATS, Math.log(m / u)));
    }
  }
  return weights;
}

function fitWeights(cases: CalibrationCase[]): { weights: ReconciliationFSWeights; counts: Counts; byFamily: Record<string, Counts>; diagnostics: Record<string, unknown> } {
  const counts = emptyCounts();
  const byFamily: Record<string, Counts> = {};
  for (const item of cases.filter((row) => splitFor(row.seedGroup) === "train")) {
    const familyCounts = byFamily[item.family] ?? (byFamily[item.family] = emptyCounts());
    for (const pair of pairData(item)) {
      if (pair.isTruth) {
        countFeatures(counts, pair, "m");
        countFeatures(familyCounts, pair, "m");
      } else {
        countFeatures(counts, pair, "u");
        countFeatures(familyCounts, pair, "u");
      }
    }
  }
  const weights = fitCategoryWeights(counts);
  const familyWeights = Object.fromEntries(Object.entries(byFamily).map(([family, familyCounts]) => [family, fitCategoryWeights(familyCounts)]));
  const families = Object.keys(familyWeights);
  const macroWeights = Object.fromEntries(RECONCILIATION_FS_CATEGORIES.map((category) => [category,
    families.reduce((sum, family) => sum + familyWeights[family]![category], 0) / families.length,
  ])) as ReconciliationFSWeights;
  const pooledDeltaByFamily = Object.fromEntries(families.map((family) => [family,
    Object.fromEntries(RECONCILIATION_FS_CATEGORIES.map((category) => [category, familyWeights[family]![category] - weights[category]])),
  ]));
  return { weights, counts, byFamily, diagnostics: { byFamilyWeights: familyWeights, macroMeanWeights: macroWeights, pooledDeltaByFamily } };
}

function confidenceUpper95(errors: number, trials: number): number | null {
  if (trials === 0) return null;
  if (errors === 0) return 1 - Math.pow(1 - ONE_SIDED_CONFIDENCE, 1 / trials);
  const cdf = (p: number): number => {
    let term = Math.pow(1 - p, trials);
    let sum = term;
    for (let i = 0; i < errors; i += 1) {
      term *= ((trials - i) / (i + 1)) * (p / (1 - p));
      sum += term;
    }
    return sum;
  };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (cdf(mid) > 1 - ONE_SIDED_CONFIDENCE) low = mid;
    else high = mid;
  }
  return high;
}

function evaluate(cases: CalibrationCase[], fs: ReconciliationFSEvaluation) {
  const truthByCase = new Map<string, Map<string, boolean>>();
  let eligibleTruthCount = 0;
  for (const item of cases) {
    truthByCase.set(item.id, new Map(item.truthPairs.map((pair) => [`${pair.statementId}\0${pair.receiptId}`, pair.eligible])));
    eligibleTruthCount += item.truthPairs.filter((pair) => pair.eligible).length;
  }
  const metrics = {
    autoMatches: 0, correctAutoMatches: 0, falseAutoMatches: 0,
    autoCases: 0, falseAutoCases: 0, recoveredEligibleTruths: 0,
    eligibleTruthCount, precision: 0, recall: 0, falseAutoCaseRateUpper95: null as number | null,
  };
  for (const item of cases) {
    const result = runReconciliationEngineForFSCalibration({ statements: item.statements, receipts: item.receipts, aliases: item.aliases }, fs);
    let caseAuto = 0;
    let caseFalse = 0;
    for (const row of result.statementResults) {
      if (row.status !== "matched" || !row.matchedReceiptId) continue;
      const key = `${row.statementTransactionId}\0${row.matchedReceiptId}`;
      metrics.autoMatches += 1;
      caseAuto += 1;
      if (truthByCase.get(item.id)?.get(key) === true) {
        metrics.correctAutoMatches += 1;
        metrics.recoveredEligibleTruths += 1;
      } else {
        metrics.falseAutoMatches += 1;
        caseFalse += 1;
      }
    }
    if (caseAuto > 0) metrics.autoCases += 1;
    if (caseFalse > 0) metrics.falseAutoCases += 1;
  }
  metrics.precision = metrics.autoMatches === 0 ? 1 : metrics.correctAutoMatches / metrics.autoMatches;
  metrics.recall = metrics.eligibleTruthCount === 0 ? 0 : metrics.recoveredEligibleTruths / metrics.eligibleTruthCount;
  metrics.falseAutoCaseRateUpper95 = confidenceUpper95(metrics.falseAutoCases, metrics.autoCases);
  return metrics;
}

function thresholds(cases: CalibrationCase[], weights: ReconciliationFSWeights, waiver: boolean): number[] {
  const scores = new Set<number>();
  for (const item of cases) {
    if (splitFor(item.seedGroup) !== "validation") continue;
    for (const pair of pairData(item)) {
      if (pair.waiver !== waiver || !pair.autoGateEligible) continue;
      scores.add(reconciliationFSScore(pair.features, weights));
    }
  }
  return [...scores].sort((a, b) => a - b).concat(NO_AUTO_THRESHOLD);
}

function tallyRoutes(cases: CalibrationCase[], fs: ReconciliationFSEvaluation) {
  const routes = { normal: { autoMatches: 0, correct: 0, errors: 0, activeCases: 0, errorCases: 0, recovered: 0, eligible: 0 },
    waiver: { autoMatches: 0, correct: 0, errors: 0, activeCases: 0, errorCases: 0, recovered: 0, eligible: 0 } };
  for (const item of cases) {
    const pairRows = pairData(item);
    const truth = new Map(item.truthPairs.map((pair) => [`${pair.statementId}\0${pair.receiptId}`, pair.eligible]));
    const byKey = new Map(pairRows.map((pair) => [pair.key, pair]));
    for (const pair of pairRows) if (pair.eligibleTruth) routes[pair.waiver ? "waiver" : "normal"].eligible += 1;
    const result = runReconciliationEngineForFSCalibration({ statements: item.statements, receipts: item.receipts, aliases: item.aliases }, fs);
    const caseStats = { normal: { count: 0, errors: 0 }, waiver: { count: 0, errors: 0 } };
    for (const row of result.statementResults) {
      if (row.status !== "matched" || !row.matchedReceiptId) continue;
      const key = `${row.statementTransactionId}\0${row.matchedReceiptId}`;
      const pair = byKey.get(key);
      if (!pair) throw new Error(`Engine emitted a non-candidate pair ${item.id}/${key}`);
      const route = pair.waiver ? "waiver" : "normal";
      const stats = routes[route];
      stats.autoMatches += 1;
      caseStats[route].count += 1;
      if (truth.get(key) === true) {
        stats.correct += 1;
        stats.recovered += 1;
      } else {
        stats.errors += 1;
        caseStats[route].errors += 1;
      }
    }
    for (const route of ["normal", "waiver"] as const) {
      if (caseStats[route].count > 0) routes[route].activeCases += 1;
      if (caseStats[route].errors > 0) routes[route].errorCases += 1;
    }
  }
  return routes;
}

function chooseThresholds(cases: CalibrationCase[], weights: ReconciliationFSWeights) {
  const validationCases = cases.filter((item) => splitFor(item.seedGroup) === "validation");
  const normalCandidates = thresholds(cases, weights, false);
  const waiverCandidates = thresholds(cases, weights, true);
  const selection = { normalThreshold: NO_AUTO_THRESHOLD, waiverThreshold: NO_AUTO_THRESHOLD, waiverEnabled: true,
    normalQualified: false, waiverQualified: false, normalCandidates, waiverCandidates,
    thresholdTrials: { normal: [] as Array<Record<string, number | boolean | null>>, waiver: [] as Array<Record<string, number | boolean | null>> } };
  // Select each path against its own held-out stratum, with the other path disabled.
  for (const route of ["normal", "waiver"] as const) {
    const choices = route === "normal" ? normalCandidates : waiverCandidates;
    for (const threshold of choices) {
      const evaluation: ReconciliationFSEvaluation = {
        weights,
        normalThreshold: route === "normal" ? threshold : NO_AUTO_THRESHOLD,
        waiverThreshold: route === "waiver" ? threshold : NO_AUTO_THRESHOLD,
        waiverEnabled: route === "waiver",
      };
      const metrics = tallyRoutes(validationCases, evaluation)[route];
      const upper = confidenceUpper95(metrics.errorCases, metrics.activeCases);
      selection.thresholdTrials[route].push({ threshold, autoMatches: metrics.autoMatches, correct: metrics.correct,
        errors: metrics.errors, activeCases: metrics.activeCases, errorCases: metrics.errorCases, upper95: upper,
        recall: metrics.eligible === 0 ? 0 : metrics.recovered / metrics.eligible,
        targetMet: upper !== null && upper <= FALSE_AUTO_CASE_RATE_TARGET });
      if (upper !== null && upper <= FALSE_AUTO_CASE_RATE_TARGET) {
        if (route === "normal") { selection.normalThreshold = threshold; selection.normalQualified = true; }
        else { selection.waiverThreshold = threshold; selection.waiverQualified = true; }
        break;
      }
    }
  }
  if (!selection.waiverQualified) selection.waiverEnabled = false;
  // The two paths can compete for the same endpoints. Recheck together and raise
  // only a path whose case-clustered error upper bound fails the target.
  for (let attempt = 0; attempt < normalCandidates.length + waiverCandidates.length; attempt += 1) {
    const evaluation: ReconciliationFSEvaluation = { weights, normalThreshold: selection.normalThreshold,
      waiverThreshold: selection.waiverThreshold, waiverEnabled: selection.waiverEnabled };
    const grouped = tallyRoutes(validationCases, evaluation);
    let changed = false;
    for (const route of ["normal", "waiver"] as const) {
      if (route === "waiver" && !selection.waiverEnabled) continue;
      const stats = grouped[route];
      const upper = confidenceUpper95(stats.errorCases, stats.activeCases);
      if (upper !== null && upper <= FALSE_AUTO_CASE_RATE_TARGET) continue;
      const choices = route === "normal" ? normalCandidates : waiverCandidates;
      const current = route === "normal" ? selection.normalThreshold : selection.waiverThreshold;
      const next = choices.find((value) => value > current);
      if (next === undefined) {
        if (route === "normal") selection.normalThreshold = NO_AUTO_THRESHOLD;
        else { selection.waiverThreshold = NO_AUTO_THRESHOLD; selection.waiverEnabled = false; }
      } else if (route === "normal") selection.normalThreshold = next;
      else selection.waiverThreshold = next;
      changed = true;
    }
    if (!changed) break;
  }
  return selection;
}

function table(counts: Counts) {
  return Object.fromEntries(RECONCILIATION_FS_CATEGORIES.map((key) => {
    const mN = RECONCILIATION_FS_CATEGORIES.filter((item) => item.startsWith(`${key.split(":")[0]}:`)).reduce((sum, item) => sum + counts.mTotal[item], 0);
    const uN = RECONCILIATION_FS_CATEGORIES.filter((item) => item.startsWith(`${key.split(":")[0]}:`)).reduce((sum, item) => sum + counts.uTotal[item], 0);
    const categoryCount = RECONCILIATION_FS_CATEGORIES.filter((item) => item.startsWith(`${key.split(":")[0]}:`)).length;
    return [key, { m: counts.m[key], u: counts.u[key], mSmoothed: (counts.m[key] + ALPHA) / (mN + ALPHA * categoryCount),
      uSmoothed: (counts.u[key] + ALPHA) / (uN + ALPHA * categoryCount) }];
  }));
}

async function main() {
  process.env.RECONCILIATION_CALIBRATION_IMPORT = "1";
  const { generateCalibrationCases } = await import("./run-reconciliation-property");
  const cases = generateCalibrationCases() as CalibrationCase[];
  const trainingCases = cases.filter((item) => splitFor(item.seedGroup) === "train");
  const validationCases = cases.filter((item) => splitFor(item.seedGroup) === "validation");
  const fitted = fitWeights(trainingCases);
  const selected = chooseThresholds(cases, fitted.weights);
  const fs: ReconciliationFSEvaluation = { weights: fitted.weights, normalThreshold: selected.normalThreshold,
    waiverThreshold: selected.waiverThreshold, waiverEnabled: selected.waiverEnabled };
  const validation = evaluate(validationCases, fs);
  const routeMetrics = tallyRoutes(validationCases, fs);
  const result = {
    method: "Fellegi–Sunter conditional agreement log-ratio; offline constants only",
    generator: { propertyCases: 1200, gateCases: cases.length - 1200, propertySeed: 376, gateSeeds: 100,
      split: "seedGroup % 2 === 0 => validation; other groups => training", trainingCaseCount: trainingCases.length,
      validationCaseCount: validationCases.length },
    mU: { positive: "all generator-declared truth pairs that are candidates, including ambiguous/unrecoverable; eligibility remains separate",
      negative: "all other candidate edges inside the existing date and amount candidate windows", alpha: ALPHA,
      contributionClampNats: [-WEIGHT_CAP_NATS, WEIGHT_CAP_NATS], pooledCounts: fitted.counts, byFamily: fitted.byFamily,
      categoryTable: table(fitted.counts), weights: fitted.weights, diagnostics: fitted.diagnostics },
    thresholdSelection: { targetFalseAutoCaseRateUpper95: FALSE_AUTO_CASE_RATE_TARGET, confidence: ONE_SIDED_CONFIDENCE,
      selection: "first ascending raw score threshold whose validation case-clustered one-sided exact binomial upper bound is <= target; maximize recall by selecting the lowest qualifying threshold",
      selected, validation, byPath: routeMetrics },
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--write")) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
