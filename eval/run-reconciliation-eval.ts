import { runReconciliationEngine } from "../src/lib/reconciliation-engine";
import { reconciliationEvalDataset } from "./reconciliation-eval-dataset";

const expectedPairKey = (statementId: string, receiptId: string) => `${statementId}\u0000${receiptId}`;

function main() {
  if (reconciliationEvalDataset.length < 20) throw new Error("Reconciliation evaluation requires at least 20 synthetic cases.");

  let expectedMatchCount = 0;
  let correctAutoMatches = 0;
  let actualAutoMatches = 0;
  let statementCount = 0;
  let needsReviewCount = 0;
  let unmatchedStatementCount = 0;
  let unmatchedReceiptCount = 0;
  let stateChecks = 0;
  let correctStateChecks = 0;
  const failures: Array<{ caseId: string; issue: string }> = [];

  for (const testCase of reconciliationEvalDataset) {
    const result = runReconciliationEngine({ statements: testCase.statements, receipts: testCase.receipts });
    const actualPairs = result.statementResults.flatMap((row) => row.status === "matched" && row.matchedReceiptId
      ? [{ statementId: row.statementTransactionId, receiptId: row.matchedReceiptId }]
      : []);
    const expectedPairs = new Set(testCase.expectedMatches.map(({ statementId, receiptId }) => expectedPairKey(statementId, receiptId)));
    const actualPairKeys = new Set(actualPairs.map(({ statementId, receiptId }) => expectedPairKey(statementId, receiptId)));
    expectedMatchCount += expectedPairs.size;
    actualAutoMatches += actualPairs.length;
    correctAutoMatches += actualPairs.filter(({ statementId, receiptId }) => expectedPairs.has(expectedPairKey(statementId, receiptId))).length;
    if (result.ruleVersion.length === 0) failures.push({ caseId: testCase.id, issue: "missing rule version" });
    for (const pairKey of expectedPairs) if (!actualPairKeys.has(pairKey)) failures.push({ caseId: testCase.id, issue: `expected match missing: ${pairKey.replace("\u0000", " -> ")}` });
    for (const pairKey of actualPairKeys) if (!expectedPairs.has(pairKey)) failures.push({ caseId: testCase.id, issue: `unexpected auto-match: ${pairKey.replace("\u0000", " -> ")}` });

    const statementById = new Map(result.statementResults.map((row) => [row.statementTransactionId, row]));
    for (const [id, expectedStatus] of Object.entries(testCase.expectedStatementStatuses)) {
      const actual = statementById.get(id);
      stateChecks += 1;
      if (actual?.status === expectedStatus) correctStateChecks += 1;
      else failures.push({ caseId: testCase.id, issue: `statement ${id}: expected ${expectedStatus}, got ${actual?.status ?? "missing"}` });
      if (actual?.status === "needs_review") needsReviewCount += 1;
      if (actual?.status === "unmatched_statement") unmatchedStatementCount += 1;
      if ((actual as { status: string } | undefined)?.status === "confirmed") failures.push({ caseId: testCase.id, issue: `machine engine emitted confirmed for ${id}` });
      statementCount += 1;
    }
    const receiptById = new Map(result.receiptResults.map((row) => [row.receiptId, row]));
    for (const [id, expectedStatus] of Object.entries(testCase.expectedReceiptStatuses)) {
      const actual = receiptById.get(id);
      stateChecks += 1;
      if (actual?.status === expectedStatus) correctStateChecks += 1;
      else failures.push({ caseId: testCase.id, issue: `receipt ${id}: expected ${expectedStatus}, got ${actual?.status ?? "missing"}` });
      if (actual?.status === "unmatched_receipt") unmatchedReceiptCount += 1;
      if ((actual as { status: string } | undefined)?.status === "confirmed") failures.push({ caseId: testCase.id, issue: `machine engine emitted confirmed for receipt ${id}` });
    }
  }

  const metrics = {
    caseCount: reconciliationEvalDataset.length,
    expectedMatchCount,
    autoMatchPrecision: actualAutoMatches === 0 ? 1 : correctAutoMatches / actualAutoMatches,
    autoMatchCoverage: expectedMatchCount === 0 ? 0 : correctAutoMatches / expectedMatchCount,
    needsReviewRate: statementCount === 0 ? 0 : needsReviewCount / statementCount,
    unmatchedStatementCount,
    unmatchedReceiptCount,
    expectedStatusAccuracy: stateChecks === 0 ? 1 : correctStateChecks / stateChecks,
    unexpectedOrMissingAutoMatches: actualAutoMatches - correctAutoMatches + expectedMatchCount - correctAutoMatches,
  };
  console.log(JSON.stringify({ dataset: "eval/reconciliation-eval-dataset.ts", source: "synthetic only", ruleVersion: runReconciliationEngine({ statements: [], receipts: [] }).ruleVersion, metrics, failures }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main();
