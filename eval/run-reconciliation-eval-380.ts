/**
 * Issue #380 evaluation: old 1.2.0 vs new 1.3.0 on the same synthetic cases.
 *
 * The truth pairs and their separable/ambiguous class are fixed at generation
 * time. The brute-force oracle below is independent of the Hungarian solver:
 * it enumerates maximum-weight matchings with dynamic programming, derives Δe
 * from the original E, and reconstructs the lexicographic solution directly.
 */

import { pathToFileURL } from "node:url";
import {
  inspectReconciliationAssignment,
  merchantAliasKey,
  RECONCILIATION_RULES,
  reconciliationMerchantSimilarity,
  runReconciliationEngine,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";
import { runReconciliationEngine as runFrozenEngine } from "./frozen/reconciliation-engine-1.2.0";

const DAY = 86_400_000;
const BASE_DATE = "2026-09-01";
const SEEDS = 100;
const THRESHOLD = Math.round(RECONCILIATION_RULES.globalAssignmentMargin * RECONCILIATION_RULES.globalAssignmentWeightScale);

type TruthClass = "separable" | "ambiguous";
type Family = "chain-2" | "chain-3" | "chain-5" | "chain-10" | "twin" | "missing" | "extra" | "threshold" | "alias";

type TruthPair = {
  statementId: string;
  receiptId: string;
  truthClass: TruthClass;
};

export type EvalCase = {
  id: string;
  family: Family;
  seed: number;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases: string[];
  truthPairs: TruthPair[];
};

type Edge = { row: string; column: string; weight: number };

type OracleSolution = {
  total: number;
  assignment: Map<string, string>;
  deltas: Map<string, number>;
  autoPairs: Set<string>;
};

type PairMetrics = {
  caseCount: number;
  statementCount: number;
  receiptCount: number;
  truthPairCount: number;
  separableTruthPairCount: number;
  ambiguousTruthPairCount: number;
  newAutoCount: number;
  newCorrectCount: number;
  newFalseCount: number;
  oldAutoCount: number;
  oldCorrectCount: number;
  oldFalseCount: number;
  lostLegacyCount: number;
  netCorrectCount: number;
  precision: number;
  oldPrecision: number;
  oracleCases: number;
  optimalSumMismatchCount: number;
  deltaMismatchCount: number;
  lexicographicMismatchCount: number;
  autoSetMismatchCount: number;
};

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const pairKey = (statementId: string, receiptId: string): string => `${statementId}\u0000${receiptId}`;
const emptyPairMetrics = (): PairMetrics => ({
  caseCount: 0, statementCount: 0, receiptCount: 0, truthPairCount: 0,
  separableTruthPairCount: 0, ambiguousTruthPairCount: 0,
  newAutoCount: 0, newCorrectCount: 0, newFalseCount: 0,
  oldAutoCount: 0, oldCorrectCount: 0, oldFalseCount: 0,
  lostLegacyCount: 0, netCorrectCount: 0, precision: 1, oldPrecision: 1,
  oracleCases: 0, optimalSumMismatchCount: 0, deltaMismatchCount: 0,
  lexicographicMismatchCount: 0, autoSetMismatchCount: 0,
});

function addMetrics(target: PairMetrics, source: PairMetrics): void {
  for (const key of Object.keys(target) as Array<keyof PairMetrics>) target[key] += source[key];
}

function finalizeMetrics(metrics: PairMetrics): PairMetrics {
  return {
    ...metrics,
    precision: metrics.newAutoCount === 0 ? 1 : metrics.newCorrectCount / metrics.newAutoCount,
    oldPrecision: metrics.oldAutoCount === 0 ? 1 : metrics.oldCorrectCount / metrics.oldAutoCount,
    netCorrectCount: metrics.newCorrectCount - metrics.oldCorrectCount,
  };
}

function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00.000Z`) / DAY);
}

function statement(id: string, merchant: string, amountYen: number, usedDate: string): ReconciliationStatement {
  return {
    statementTransactionId: id, provider: "synthetic", externalId: `external-${id}`, kind: "purchase",
    usedDate, postedDate: null, merchant, amountYen, paymentMethod: null,
  };
}

function receipt(id: string, merchant: string, amountYen: number, purchasedDate: string, account: string): ReconciliationReceipt {
  return { receiptId: id, actualTransactionId: `actual-${id}`, merchant, purchasedDate, amountYen, actualAccountId: account };
}

function control(family: Family, seed: number, date: string, amountYen: number): { statements: ReconciliationStatement[]; receipts: ReconciliationReceipt[]; truth: TruthPair } {
  const statementId = `s-${family}-${seed}-control`;
  const receiptId = `r-${family}-${seed}-control`;
  const merchant = `対照商店${seed}`;
  return {
    statements: [statement(statementId, merchant, amountYen, date)],
    receipts: [receipt(receiptId, merchant, amountYen, date, "acct-control")],
    truth: { statementId, receiptId, truthClass: "separable" },
  };
}

function generateChain(length: 2 | 3 | 5 | 10, seed: number): EvalCase {
  const family = `chain-${length}` as Family;
  const start = shiftDate(BASE_DATE, 10 + (seed % 5));
  const amount = 1000 + (seed % 90) * 10;
  const controlPair = control(family, seed, shiftDate(start, -30), 900_000 + seed * 7);
  const letters = "ABCDEFGHIJ";
  const statements: ReconciliationStatement[] = [...controlPair.statements];
  const receipts: ReconciliationReceipt[] = [...controlPair.receipts];
  const truthPairs: TruthPair[] = [controlPair.truth];
  for (let index = 0; index < length; index += 1) {
    const date = shiftDate(start, index * 2);
    const merchant = `架空商店${letters[index]}`;
    const statementId = `s-${family}-${seed}-${index}`;
    const receiptId = `r-${family}-${seed}-${index}`;
    statements.push(statement(statementId, merchant, amount, date));
    receipts.push(receipt(receiptId, merchant, amount, date, `acct-${index}`));
    truthPairs.push({ statementId, receiptId, truthClass: "separable" });
  }
  return { id: `${family}-${seed}`, family, seed, statements, receipts, aliases: [], truthPairs };
}

function generateTwin(seed: number): EvalCase {
  const family: Family = "twin";
  const date = shiftDate(BASE_DATE, 5);
  const controlPair = control(family, seed, shiftDate(date, -30), 900_000 + seed * 7);
  const statementId = `s-${family}-${seed}-truth`;
  const receiptId = `r-${family}-${seed}-truth`;
  const twinId = `r-${family}-${seed}-twin`;
  const merchant = `双子商店${seed}`;
  const amount = 1200 + seed;
  return {
    id: `${family}-${seed}`, family, seed,
    statements: [...controlPair.statements, statement(statementId, merchant, amount, date)],
    receipts: [...controlPair.receipts, receipt(receiptId, merchant, amount, date, "acct-truth"), receipt(twinId, merchant, amount, date, "acct-twin")],
    aliases: [],
    truthPairs: [controlPair.truth, { statementId, receiptId, truthClass: "ambiguous" }],
  };
}

function generateMissing(seed: number): EvalCase {
  const family: Family = "missing";
  const date = shiftDate(BASE_DATE, 5);
  const controlPair = control(family, seed, shiftDate(date, -30), 900_000 + seed * 7);
  const statementId = `s-${family}-${seed}-missing`;
  const missingReceiptId = `r-${family}-${seed}-missing`;
  const decoyId = `r-${family}-${seed}-decoy`;
  const amount = 1300 + seed;
  return {
    id: `${family}-${seed}`, family, seed,
    statements: [...controlPair.statements, statement(statementId, `欠落商店${seed}`, amount, date)],
    receipts: [...controlPair.receipts, receipt(decoyId, `無関係商店${seed}`, amount, date, "acct-decoy")],
    aliases: [],
    truthPairs: [controlPair.truth, { statementId, receiptId: missingReceiptId, truthClass: "ambiguous" }],
  };
}

function generateExtra(seed: number): EvalCase {
  const family: Family = "extra";
  const date = shiftDate(BASE_DATE, 5);
  const controlPair = control(family, seed, shiftDate(date, -30), 900_000 + seed * 7);
  const statementId = `s-${family}-${seed}-truth`;
  const receiptId = `r-${family}-${seed}-truth`;
  const extraId = `r-${family}-${seed}-extra`;
  const amount = 1400 + seed;
  return {
    id: `${family}-${seed}`, family, seed,
    statements: [...controlPair.statements, statement(statementId, "余分商店A", amount, date)],
    receipts: [...controlPair.receipts,
      receipt(receiptId, "余分商店A", amount, date, "acct-truth"),
      receipt(extraId, "余分商店B", amount, shiftDate(date, 2), "acct-extra")],
    aliases: [],
    truthPairs: [controlPair.truth, { statementId, receiptId, truthClass: "ambiguous" }],
  };
}

function generateThreshold(seed: number): EvalCase {
  const family: Family = "threshold";
  const date = shiftDate(BASE_DATE, 5);
  const controlPair = control(family, seed, shiftDate(date, -30), 900_000 + seed * 7);
  const statementId = `s-${family}-${seed}-truth`;
  const receiptId = `r-${family}-${seed}-truth`;
  const belowId = `r-${family}-${seed}-below`;
  const amount = 1500 + seed;
  return {
    id: `${family}-${seed}`, family, seed,
    statements: [...controlPair.statements, statement(statementId, "湖畔ベーカリー新宿", amount, date)],
    receipts: [...controlPair.receipts,
      receipt(receiptId, "湖畔ベーカリー新宿", amount, date, "acct-truth"),
      receipt(belowId, "湖畔ベーカリー２号店", amount, shiftDate(date, 2), "acct-below")],
    aliases: [],
    truthPairs: [controlPair.truth, { statementId, receiptId, truthClass: "separable" }],
  };
}

function generateAlias(seed: number): EvalCase {
  const family: Family = "alias";
  const date = shiftDate(BASE_DATE, 5);
  const controlPair = control(family, seed, shiftDate(date, -30), 900_000 + seed * 7);
  const statementId = `s-${family}-${seed}-truth`;
  const receiptId = `r-${family}-${seed}-truth`;
  const competitorId = `r-${family}-${seed}-comp`;
  const amount = 1600 + seed;
  const statementRow = statement(statementId, "架空ストア", amount, date);
  const truthRow = receipt(receiptId, "別名ストア", amount, date, "acct-truth");
  const competitorRow = receipt(competitorId, "別名商店", amount, date, "acct-comp");
  return {
    id: `${family}-${seed}`, family, seed,
    statements: [...controlPair.statements, statementRow],
    receipts: [...controlPair.receipts, truthRow, competitorRow],
    aliases: [merchantAliasKey(statementRow.merchant, truthRow.merchant), merchantAliasKey(statementRow.merchant, competitorRow.merchant)],
    truthPairs: [controlPair.truth, { statementId, receiptId, truthClass: "ambiguous" }],
  };
}

export function generateCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const length of [2, 3, 5, 10] as const) {
    for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateChain(length, seed));
  }
  for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateTwin(seed));
  for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateMissing(seed));
  for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateExtra(seed));
  for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateThreshold(seed));
  for (let seed = 0; seed < SEEDS; seed += 1) cases.push(generateAlias(seed));
  return cases;
}

// ---------- independent brute-force oracle ----------

function autoScoreFor(statementRow: ReconciliationStatement, receiptRow: ReconciliationReceipt, aliasMatch: boolean): number {
  const amountDelta = Math.abs(statementRow.amountYen - receiptRow.amountYen);
  const tolerance = Math.max(RECONCILIATION_RULES.amountToleranceAbsoluteYen, statementRow.amountYen * RECONCILIATION_RULES.amountToleranceRatio);
  const amountScore = amountDelta === 0 ? 1 : Math.max(0, 1 - amountDelta / tolerance);
  const dateScore = 1 - Math.abs(dayNumber(statementRow.usedDate) - dayNumber(receiptRow.purchasedDate)) / (RECONCILIATION_RULES.candidateDateWindowDays + 1);
  const merchantScore = aliasMatch ? 1 : reconciliationMerchantSimilarity(statementRow.merchant, receiptRow.merchant);
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return round(amountScore * RECONCILIATION_RULES.autoMatchAmountWeight + dateScore * RECONCILIATION_RULES.autoMatchDateWeight + merchantScore * RECONCILIATION_RULES.autoMatchMerchantWeight);
}

function buildEdges(testCase: EvalCase): Edge[] {
  const aliases = new Set(testCase.aliases);
  const edges: Edge[] = [];
  for (const statementRow of testCase.statements) {
    if (statementRow.kind !== "purchase") continue;
    for (const receiptRow of testCase.receipts) {
      const amountDelta = Math.abs(statementRow.amountYen - receiptRow.amountYen);
      const dateDistance = Math.abs(dayNumber(statementRow.usedDate) - dayNumber(receiptRow.purchasedDate));
      const aliasMatch = aliases.has(merchantAliasKey(statementRow.merchant, receiptRow.merchant));
      const similarity = reconciliationMerchantSimilarity(statementRow.merchant, receiptRow.merchant);
      if (amountDelta !== 0 || dateDistance > RECONCILIATION_RULES.autoMatchDateWindowDays) continue;
      if (similarity < RECONCILIATION_RULES.autoMatchMerchantSimilarity && !aliasMatch) continue;
      const autoScore = autoScoreFor(statementRow, receiptRow, aliasMatch);
      if (autoScore < RECONCILIATION_RULES.autoMatchScore) continue;
      edges.push({ row: statementRow.statementTransactionId, column: receiptRow.receiptId, weight: Math.floor(1_000_000 * autoScore + 0.5) });
    }
  }
  return edges;
}

type OracleDp = {
  total: number;
  assignment: Map<string, string>;
};

function oracleAssignment(edges: readonly Edge[], rows: readonly string[], columns: readonly string[]): OracleDp {
  const rowEdges = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = rowEdges.get(edge.row) ?? [];
    list.push(edge);
    rowEdges.set(edge.row, list);
  }
  for (const list of rowEdges.values()) list.sort((left, right) => compareText(left.column, right.column));
  const columnIndex = new Map(columns.map((column, index) => [column, index]));
  const width = columns.length;
  const memo = new Map<number, number>();
  const choice = new Map<number, number>();
  const solve = (rowIndex: number, mask: number): number => {
    if (rowIndex === rows.length) return 0;
    const key = rowIndex * (1 << width) + mask;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const row = rows[rowIndex]!;
    let best = -1;
    let bestChoice = -1;
    for (const edge of rowEdges.get(row) ?? []) {
      const index = columnIndex.get(edge.column);
      if (index === undefined || (mask & (1 << index)) !== 0) continue;
      const value = edge.weight + solve(rowIndex + 1, mask | (1 << index));
      if (value > best) {
        best = value;
        bestChoice = index;
      }
    }
    const skipped = solve(rowIndex + 1, mask);
    if (skipped > best) {
      best = skipped;
      bestChoice = -1;
    }
    memo.set(key, best);
    choice.set(key, bestChoice);
    return best;
  };
  const total = solve(0, 0);
  // The DP prefers a real column over unassigned and visits columns in id order,
  // so reconstructing this choice table gives the lexicographic assignment.
  const orderedColumns = columns;
  const assign = new Map<string, string>();
  let mask = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = rowIndex * (1 << width) + mask;
    const selected = choice.get(key) ?? -1;
    if (selected >= 0) {
      const column = orderedColumns[selected]!;
      assign.set(rows[rowIndex]!, column);
      mask |= 1 << selected;
    }
  }
  return { total, assignment: assign };
}

function oracleSolution(testCase: EvalCase): OracleSolution {
  const edges = buildEdges(testCase);
  const rows = testCase.statements.map((row) => row.statementTransactionId).sort(compareText);
  const columns = testCase.receipts.map((row) => row.receiptId).sort(compareText);
  const solved = oracleAssignment(edges, rows, columns);
  const deltas = new Map<string, number>();
  const autoPairs = new Set<string>();
  for (const [statementId, receiptId] of solved.assignment) {
    const filtered = edges.filter((edge) => !(edge.row === statementId && edge.column === receiptId));
    const without = oracleAssignment(filtered, rows, columns).total;
    const delta = solved.total - without;
    deltas.set(pairKey(statementId, receiptId), delta);
    if (delta >= THRESHOLD) autoPairs.add(pairKey(statementId, receiptId));
  }
  return { total: solved.total, assignment: solved.assignment, deltas, autoPairs };
}

// ---------- old/new comparison ----------

type AutoPair = { statementId: string; receiptId: string };

function autoPairsOf(result: { statementResults: Array<{ statementTransactionId: string; status: string; matchedReceiptId: string | null }> }): Map<string, AutoPair> {
  const pairs = new Map<string, AutoPair>();
  for (const row of result.statementResults) {
    if (row.status !== "matched" || !row.matchedReceiptId) continue;
    pairs.set(pairKey(row.statementTransactionId, row.matchedReceiptId), { statementId: row.statementTransactionId, receiptId: row.matchedReceiptId });
  }
  return pairs;
}

function metricsForCase(testCase: EvalCase): {
  overall: PairMetrics;
  separable: PairMetrics;
  ambiguous: PairMetrics;
  oracle: OracleSolution;
  newResult: ReturnType<typeof runReconciliationEngine>;
  oldResult: ReturnType<typeof runFrozenEngine>;
} {
  const overall = emptyPairMetrics();
  const separable = emptyPairMetrics();
  const ambiguous = emptyPairMetrics();
  const aliases = new Set(testCase.aliases);
  const newResult = runReconciliationEngine({ statements: testCase.statements, receipts: testCase.receipts, aliases });
  const oldResult = runFrozenEngine({ statements: testCase.statements, receipts: testCase.receipts, aliases });
  const oracle = oracleSolution(testCase);
  const newPairs = autoPairsOf(newResult);
  const oldPairs = autoPairsOf(oldResult);
  const acceptable = new Set<string>();
  const statementClass = new Map<string, TruthClass>();
  let hasSeparable = false;
  let hasAmbiguous = false;
  for (const truth of testCase.truthPairs) {
    statementClass.set(truth.statementId, truth.truthClass);
    if (truth.truthClass === "separable") {
      acceptable.add(pairKey(truth.statementId, truth.receiptId));
      hasSeparable = true;
    } else {
      hasAmbiguous = true;
    }
  }
  const applyCounts = (pairs: Map<string, AutoPair>, old: boolean): void => {
    for (const [key, pair] of pairs) {
      const truthClass = statementClass.get(pair.statementId) ?? "ambiguous";
      const classMetrics = truthClass === "separable" ? separable : ambiguous;
      for (const target of [overall, classMetrics]) {
        if (old) target.oldAutoCount += 1;
        else target.newAutoCount += 1;
        if (acceptable.has(key)) {
          if (old) target.oldCorrectCount += 1;
          else target.newCorrectCount += 1;
        } else if (old) {
          target.oldFalseCount += 1;
        } else {
          target.newFalseCount += 1;
        }
      }
    }
  };
  applyCounts(newPairs, false);
  applyCounts(oldPairs, true);
  for (const key of oldPairs.keys()) {
    if (!acceptable.has(key) || newPairs.has(key)) continue;
    const pair = oldPairs.get(key)!;
    const classMetrics = (statementClass.get(pair.statementId) ?? "ambiguous") === "separable" ? separable : ambiguous;
    classMetrics.lostLegacyCount += 1;
    overall.lostLegacyCount += 1;
  }
  for (const truth of testCase.truthPairs) {
    const classMetrics = truth.truthClass === "separable" ? separable : ambiguous;
    classMetrics.truthPairCount += 1;
    if (truth.truthClass === "separable") classMetrics.separableTruthPairCount += 1;
    else classMetrics.ambiguousTruthPairCount += 1;
    overall.truthPairCount += 1;
    if (truth.truthClass === "separable") overall.separableTruthPairCount += 1;
    else overall.ambiguousTruthPairCount += 1;
  }
  overall.caseCount = 1;
  overall.statementCount = testCase.statements.length;
  overall.receiptCount = testCase.receipts.length;
  if (hasSeparable) separable.caseCount = 1;
  if (hasAmbiguous) ambiguous.caseCount = 1;
  for (const classMetrics of [overall, separable, ambiguous]) {
    if (classMetrics.statementCount === 0) classMetrics.statementCount = testCase.statements.length;
    if (classMetrics.receiptCount === 0) classMetrics.receiptCount = testCase.receipts.length;
  }
  // Pull the assignment diagnostics through the oracle comparison helper below.
  const diagnostics = inspectReconciliationAssignment({
    statements: testCase.statements, receipts: testCase.receipts, aliases,
  });
  overall.oracleCases += 1;
  if (separable.caseCount > 0) separable.oracleCases += 1;
  if (ambiguous.caseCount > 0) ambiguous.oracleCases += 1;
  if (diagnostics.optimumWeight !== oracle.total) {
    overall.optimalSumMismatchCount += 1;
    if (separable.caseCount > 0) separable.optimalSumMismatchCount += 1;
    if (ambiguous.caseCount > 0) ambiguous.optimalSumMismatchCount += 1;
  }
  const engineAssignment = new Map(diagnostics.assignment.map((row) => [row.statementTransactionId, row.receiptId]));
  const engineDeltas = new Map(diagnostics.deltas.map((row) => [pairKey(row.statementTransactionId, row.receiptId), row.delta]));
  const assignmentMismatch = engineAssignment.size !== oracle.assignment.size
    || [...engineAssignment].some(([statementId, receiptId]) => oracle.assignment.get(statementId) !== receiptId);
  const deltaMismatch = engineDeltas.size !== oracle.deltas.size
    || [...engineDeltas].some(([key, delta]) => oracle.deltas.get(key) !== delta);
  const engineAuto = new Set(diagnostics.deltas.filter((row) => row.automatic).map((row) => pairKey(row.statementTransactionId, row.receiptId)));
  const autoSetMismatch = engineAuto.size !== oracle.autoPairs.size || [...engineAuto].some((key) => !oracle.autoPairs.has(key));
  const mismatchTargets = [overall, ...[separable, ambiguous].filter((metrics) => metrics.caseCount > 0)];
  for (const classMetrics of mismatchTargets) {
    if (assignmentMismatch) classMetrics.lexicographicMismatchCount += 1;
    if (deltaMismatch) classMetrics.deltaMismatchCount += 1;
    if (autoSetMismatch) classMetrics.autoSetMismatchCount += 1;
  }
  return { overall, separable, ambiguous, oracle, newResult, oldResult };
}

function main(): void {
  const cases = generateCases();
  const overall = emptyPairMetrics();
  const byFamily = new Map<Family, PairMetrics>();
  const byClass = new Map<TruthClass, PairMetrics>([["separable", emptyPairMetrics()], ["ambiguous", emptyPairMetrics()]]);
  const casesReport: Array<{ id: string; family: Family; truthPairs: number; newAuto: number; newCorrect: number; newFalse: number; lostLegacy: number }> = [];

  for (const testCase of cases) {
    const outcome = metricsForCase(testCase);
    addMetrics(overall, outcome.overall);
    const family = byFamily.get(testCase.family) ?? emptyPairMetrics();
    addMetrics(family, outcome.overall);
    byFamily.set(testCase.family, family);
    addMetrics(byClass.get("separable")!, outcome.separable);
    addMetrics(byClass.get("ambiguous")!, outcome.ambiguous);
    casesReport.push({
      id: testCase.id, family: testCase.family, truthPairs: outcome.overall.truthPairCount,
      newAuto: outcome.overall.newAutoCount, newCorrect: outcome.overall.newCorrectCount,
      newFalse: outcome.overall.newFalseCount, lostLegacy: outcome.overall.lostLegacyCount,
    });
  }

  const finalOverall = finalizeMetrics(overall);
  const finalByFamily: Record<string, PairMetrics> = {};
  for (const family of ["chain-2", "chain-3", "chain-5", "chain-10", "twin", "missing", "extra", "threshold", "alias"] as const) {
    const metrics = byFamily.get(family);
    if (metrics) finalByFamily[family] = finalizeMetrics(metrics);
  }
  const finalByClass: Record<string, PairMetrics> = {};
  for (const truthClass of ["separable", "ambiguous"] as const) {
    finalByClass[truthClass] = finalizeMetrics(byClass.get(truthClass)!);
  }

  const chainFamilies = ["chain-2", "chain-3", "chain-5", "chain-10"] as const;
  const chainNewCorrect = chainFamilies.reduce((sum, family) => sum + (finalByFamily[family]?.newCorrectCount ?? 0), 0);
  const chainOldCorrect = chainFamilies.reduce((sum, family) => sum + (finalByFamily[family]?.oldCorrectCount ?? 0), 0);
  const chainNet = chainNewCorrect - chainOldCorrect;
  const chainIncreaseRatio = chainOldCorrect === 0 ? null : chainNewCorrect / chainOldCorrect - 1;
  const chainEachLengthPositive = chainFamilies.every((family) => (finalByFamily[family]?.netCorrectCount ?? 0) > 0);

  const report = {
    dataset: "eval/run-reconciliation-eval-380.ts",
    generatorVersion: "1",
    caseCount: cases.length,
    seedsPerFamily: SEEDS,
    threshold: THRESHOLD,
    ruleVersion: runReconciliationEngine({ statements: [], receipts: [] }).ruleVersion,
    oldRuleVersion: runFrozenEngine({ statements: [], receipts: [] }).ruleVersion,
    overall: finalOverall,
    byClass: finalByClass,
    byFamily: finalByFamily,
    chain: {
      newCorrect: chainNewCorrect,
      oldCorrect: chainOldCorrect,
      netCorrect: chainNet,
      increaseRatio: chainIncreaseRatio,
      eachLengthNetPositive: chainEachLengthPositive,
    },
    gates: {
      newFalseZero: finalOverall.newFalseCount === 0,
      lostLegacyZero: finalOverall.lostLegacyCount === 0,
      oracleAllZero: finalOverall.optimalSumMismatchCount === 0 && finalOverall.deltaMismatchCount === 0
        && finalOverall.lexicographicMismatchCount === 0 && finalOverall.autoSetMismatchCount === 0,
      chainIncreaseAtLeastTenPercent: chainOldCorrect > 0 ? chainNewCorrect >= chainOldCorrect * 1.1 : chainNewCorrect > 0,
      chainEachLengthPositive,
    },
    cases: casesReport,
  };
  console.log(JSON.stringify(report, null, 2));
  const failed = !report.gates.newFalseZero || !report.gates.lostLegacyZero || !report.gates.oracleAllZero
    || !report.gates.chainIncreaseAtLeastTenPercent || !report.gates.chainEachLengthPositive;
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
