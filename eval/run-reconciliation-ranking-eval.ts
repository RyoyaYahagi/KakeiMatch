/**
 * Issue #380 PR A ranking evaluation.
 *
 * The 1,700-case gate measures automatic-match safety. This small synthetic
 * set measures the review-ranking behavior that the gate does not exercise:
 * whether the global assignment partner becomes the first candidate, and
 * whether the first candidate is the intended receipt in separable cases.
 *
 * Run with:
 *   node --conditions=react-server --import tsx eval/run-reconciliation-ranking-eval.ts
 */

import {
  inspectReconciliationRanking,
  runReconciliationEngine,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";
import { runReconciliationEngine as runFrozenEngine } from "./frozen/reconciliation-engine-1.2.0";

type TruthPair = { statementId: string; receiptId: string; separable: boolean };

type RankingCase = {
  id: string;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  preferred: Record<string, string[]>;
  manualStatementIds?: string[];
  truthPairs: TruthPair[];
};

function statement(id: string, merchant: string, date = "2026-09-10", amountYen = 1000): ReconciliationStatement {
  return {
    statementTransactionId: id, provider: "synthetic", externalId: `external-${id}`, kind: "purchase",
    usedDate: date, postedDate: null, merchant, amountYen, paymentMethod: null,
  };
}

function receipt(id: string, merchant: string, date = "2026-09-10", account = `acct-${id}`, amountYen = 1000): ReconciliationReceipt {
  return { receiptId: id, actualTransactionId: `actual-${id}`, merchant, purchasedDate: date, amountYen, actualAccountId: account };
}

const cases: RankingCase[] = [
  {
    id: "conflict-improves",
    statements: [statement("s1", "架空商店アルファ"), statement("s2", "無関係カフェ")],
    receipts: [receipt("r1", "架空商店アルファ", "2026-09-10", "acct-1"), receipt("r2", "架空商店アルファ", "2026-09-11", "acct-2")],
    preferred: { s1: [], s2: ["acct-1"] },
    truthPairs: [{ statementId: "s1", receiptId: "r2", separable: true }, { statementId: "s2", receiptId: "r1", separable: true }],
  },
  {
    id: "conflict-trades",
    statements: [statement("s1", "架空商店アルファ"), statement("s2", "無関係カフェ")],
    receipts: [receipt("r1", "架空商店アルファ", "2026-09-10", "acct-1"), receipt("r2", "架空商店アルファ", "2026-09-11", "acct-2")],
    preferred: { s1: [], s2: ["acct-1"] },
    truthPairs: [{ statementId: "s1", receiptId: "r1", separable: true }, { statementId: "s2", receiptId: "r2", separable: true }],
  },
  {
    id: "unique-pairs",
    statements: [statement("s1", "青空食堂"), statement("s2", "北口食堂")],
    receipts: [receipt("r1", "青空食堂"), receipt("r2", "北口食堂")],
    preferred: { s1: [], s2: [] },
    truthPairs: [{ statementId: "s1", receiptId: "r1", separable: true }, { statementId: "s2", receiptId: "r2", separable: true }],
  },
  {
    id: "all-conflict-4x4",
    statements: [0, 1, 2, 3].map((index) => statement(`s${index}`, "同一商店", "2026-01-01", 1000)),
    receipts: [0, 1, 2, 3].map((index) => receipt(`r${index}`, "同一商店", "2026-01-01", `acct-${index}`, 1000)),
    preferred: { s0: [], s1: [], s2: [], s3: [] },
    // Every pair conflicts, so this case is judged only by candidate-set equality.
    truthPairs: [],
  },
  {
    id: "manual-endpoint",
    statements: [statement("s1", "架空商店アルファ"), statement("s2", "無関係カフェ")],
    receipts: [receipt("r1", "架空商店アルファ", "2026-09-10", "acct-1"), receipt("r2", "架空商店アルファ", "2026-09-11", "acct-2")],
    preferred: { s1: [], s2: ["acct-1"] },
    manualStatementIds: ["s1"],
    truthPairs: [{ statementId: "s2", receiptId: "r1", separable: true }],
  },
  {
    id: "automatic-endpoint",
    statements: [statement("s1", "青空食堂", "2026-09-10", 1200), statement("s2", "無関係カフェ", "2026-09-10", 1200)],
    receipts: [receipt("r1", "青空食堂", "2026-09-10", "acct-1", 1200), receipt("r2", "無関係カフェ", "2026-09-17", "acct-2", 1200)],
    preferred: { s1: [], s2: ["acct-1"] },
    truthPairs: [{ statementId: "s1", receiptId: "r1", separable: true }, { statementId: "s2", receiptId: "r2", separable: true }],
  },
];

function inputOf(item: RankingCase) {
  return {
    statements: item.statements.map((row) => ({ ...row, preferredAccountIds: item.preferred[row.statementTransactionId] ?? [] })),
    receipts: item.receipts,
    manualStatementIds: item.manualStatementIds ? new Set(item.manualStatementIds) : undefined,
  };
}

function firstCandidate(result: ReturnType<typeof runReconciliationEngine>, statementId: string): string | null {
  return result.candidates.find((candidate) => candidate.statementTransactionId === statementId)?.receiptId ?? null;
}

const summary = {
  caseCount: cases.length,
  assignmentCount: 0,
  assignedFirstCount: 0,
  assignmentDoubleCount: 0,
  candidateSetCheckedStatementCount: 0,
  candidateSetMismatchStatementCount: 0,
  candidateSetMissingCount: 0,
  candidateSetExtraCount: 0,
  firstCandidateMissingCount: 0,
  newSeparableChecks: 0,
  newSeparableHits: 0,
  oldSeparableChecks: 0,
  oldSeparableHits: 0,
  newAutoMatches: 0,
  oldAutoMatches: 0,
  autoMatchSetDifferenceCount: 0,
  cases: [] as Array<Record<string, unknown>>,
};

function candidateSets(result: ReturnType<typeof runReconciliationEngine>): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const candidate of result.candidates) {
    const set = sets.get(candidate.statementTransactionId) ?? new Set<string>();
    set.add(candidate.receiptId);
    sets.set(candidate.statementTransactionId, set);
  }
  return sets;
}

for (const item of cases) {
  const input = inputOf(item);
  const result = runReconciliationEngine(input);
  const old = runFrozenEngine(input);
  const ranking = inspectReconciliationRanking(input);
  const newSets = candidateSets(result);
  const oldSets = candidateSets(old);
  for (const row of item.statements) {
    summary.candidateSetCheckedStatementCount += 1;
    const newSet = newSets.get(row.statementTransactionId) ?? new Set<string>();
    const oldSet = oldSets.get(row.statementTransactionId) ?? new Set<string>();
    const missing = [...oldSet].filter((receiptId) => !newSet.has(receiptId));
    const extra = [...newSet].filter((receiptId) => !oldSet.has(receiptId));
    summary.candidateSetMissingCount += missing.length;
    summary.candidateSetExtraCount += extra.length;
    if (missing.length > 0 || extra.length > 0) summary.candidateSetMismatchStatementCount += 1;
  }
  const usedReceipts = new Set<string>();
  for (const pair of ranking.assignments) {
    summary.assignmentCount += 1;
    if (usedReceipts.has(pair.receiptId)) summary.assignmentDoubleCount += 1;
    usedReceipts.add(pair.receiptId);
    if (firstCandidate(result, pair.statementTransactionId) === pair.receiptId) summary.assignedFirstCount += 1;
  }
  const newPairs = new Set(result.statementResults.filter((row) => row.status === "matched" && row.matchedReceiptId)
    .map((row) => `${row.statementTransactionId}\0${row.matchedReceiptId}`));
  const oldPairs = new Set(old.statementResults.filter((row) => row.status === "matched" && row.matchedReceiptId)
    .map((row) => `${row.statementTransactionId}\0${row.matchedReceiptId}`));
  summary.newAutoMatches += newPairs.size;
  summary.oldAutoMatches += oldPairs.size;
  summary.autoMatchSetDifferenceCount += [...oldPairs].filter((pair) => !newPairs.has(pair)).length
    + [...newPairs].filter((pair) => !oldPairs.has(pair)).length;
  for (const truth of item.truthPairs) {
    if (!truth.separable) continue;
    const newFirst = firstCandidate(result, truth.statementId);
    const oldFirst = firstCandidate(old, truth.statementId);
    if (newFirst === null) summary.firstCandidateMissingCount += 1;
    if (oldFirst === null) summary.firstCandidateMissingCount += 1;
    summary.newSeparableChecks += 1;
    summary.oldSeparableChecks += 1;
    if (newFirst === truth.receiptId) summary.newSeparableHits += 1;
    if (oldFirst === truth.receiptId) summary.oldSeparableHits += 1;
  }
  summary.cases.push({
    id: item.id,
    assignments: ranking.assignments,
    newFirst: item.statements.map((row) => [row.statementTransactionId, firstCandidate(result, row.statementTransactionId)]),
    oldFirst: item.statements.map((row) => [row.statementTransactionId, firstCandidate(old, row.statementTransactionId)]),
    newCandidateSets: item.statements.map((row) => [row.statementTransactionId, [...(newSets.get(row.statementTransactionId) ?? [])]]),
    oldCandidateSets: item.statements.map((row) => [row.statementTransactionId, [...(oldSets.get(row.statementTransactionId) ?? [])]]),
  });
}

const rate = (hits: number, checks: number) => (checks === 0 ? null : hits / checks);
const report = {
  dataset: "eval/run-reconciliation-ranking-eval.ts",
  ruleVersion: runReconciliationEngine({ statements: [], receipts: [] }).ruleVersion,
  ...summary,
  assignedFirstRate: rate(summary.assignedFirstCount, summary.assignmentCount),
  newSeparableFirstCandidateRate: rate(summary.newSeparableHits, summary.newSeparableChecks),
  oldSeparableFirstCandidateRate: rate(summary.oldSeparableHits, summary.oldSeparableChecks),
};
console.log(JSON.stringify(report, null, 2));
if (summary.assignmentDoubleCount > 0 || summary.candidateSetMismatchStatementCount > 0
  || summary.candidateSetMissingCount > 0 || summary.candidateSetExtraCount > 0
  || summary.firstCandidateMissingCount > 0 || summary.autoMatchSetDifferenceCount > 0) process.exitCode = 1;
