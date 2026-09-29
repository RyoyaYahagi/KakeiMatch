import { merchantAliasKey, runReconciliationEngine, type ReconciliationStatement } from "@/lib/reconciliation-engine";
import { getLatestReconciliationRun, getReconciliationInputs, saveReconciliationRun } from "@/lib/reconciliation-repository";

/** Reads only owner-scoped canonical/final values and saves one new machine snapshot. */
export async function runReconciliation(userId: string) {
  const input = await getReconciliationInputs(userId);
  const statements: ReconciliationStatement[] = input.statements.map((statement) => {
    if (statement.kind !== "purchase" && statement.kind !== "refund") throw new Error("invalid_statement_kind");
    return { ...statement, kind: statement.kind };
  });
  const aliases = new Set(input.aliases.map((alias) => merchantAliasKey(alias.normalizedMerchant, alias.normalizedAlias)));
  const result = runReconciliationEngine({ statements, receipts: input.receipts, aliases });
  const runId = await saveReconciliationRun({ userId, ...result });
  return {
    runId,
    ruleVersion: result.ruleVersion,
    statementCounts: {
      matched: result.statementResults.filter((item) => item.status === "matched").length,
      needsReview: result.statementResults.filter((item) => item.status === "needs_review").length,
      unmatched: result.statementResults.filter((item) => item.status === "unmatched_statement").length,
    },
    receiptCounts: {
      matched: result.receiptResults.filter((item) => item.status === "matched").length,
      needsReview: result.receiptResults.filter((item) => item.status === "needs_review").length,
      unmatched: result.receiptResults.filter((item) => item.status === "unmatched_receipt").length,
    },
  };
}

/** Issue #13 can consume the latest completed candidate/result snapshot through this boundary. */
export async function getLatestReconciliation(userId: string) {
  return getLatestReconciliationRun(userId);
}
