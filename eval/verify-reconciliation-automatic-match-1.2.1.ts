/**
 * Reproducible automatic-match invariance check for Issue #389 / PR #390.
 *
 * The PR changed only review-candidate ranking, so the automatic-match pairs
 * and statuses must stay identical to rule 1.2.1. This script extracts the
 * 1.2.1 engine and assignment module from the PR's base commit, runs both
 * engines over the same 1,738 cases, and diffs the automatic-match pairs and
 * every statement/receipt status.
 *
 * The 1.2.1 engine is never checked in: it is read with `git show` from the
 * base commit, so the comparison is tied to an immutable revision.
 *
 * Run with:
 *   node --conditions=react-server --import tsx eval/verify-reconciliation-automatic-match-1.2.1.ts
 *   pnpm eval:reconciliation-automatic-match
 *
 * Override the base revision when the PR base changes:
 *   RECONCILIATION_1_2_1_COMMIT=<sha> pnpm eval:reconciliation-automatic-match
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RECONCILIATION_RULE_VERSION,
  runReconciliationEngine,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";
import { reconciliationEvalDataset } from "./reconciliation-eval-dataset";
import {
  generateGateCases,
  generateGateDedicatedCases,
  generateRobustnessGateCases,
} from "./reconciliation-gate-dataset";

const DEFAULT_BASE_COMMIT = "db5e7725a4de46b0aad10fce2790981510c22faf";
const BASE_COMMIT = process.env.RECONCILIATION_1_2_1_COMMIT ?? DEFAULT_BASE_COMMIT;
const BASE_FILES = ["src/lib/reconciliation-engine.ts", "src/lib/assignment.ts"] as const;

type ComparisonCase = {
  dataset: "synthetic" | "gate" | "dedicated";
  id: string;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases?: ReadonlySet<string>;
};

type EngineResult = {
  ruleVersion: string;
  statementResults: Array<{ statementTransactionId: string; status: string; matchedReceiptId: string | null }>;
  receiptResults: Array<{ receiptId: string; status: string; matchedStatementTransactionId: string | null }>;
};

type Difference = {
  dataset: ComparisonCase["dataset"];
  caseId: string;
  kind: "automatic_pair" | "statement_status" | "receipt_status";
  rowId: string;
  expected: string;
  actual: string;
};

function gitShow(path: string): string {
  return execFileSync("git", ["show", `${BASE_COMMIT}:${path}`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function automaticPairs(result: EngineResult): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const row of result.statementResults) {
    if (row.status === "matched" && row.matchedReceiptId) {
      pairs.set(row.statementTransactionId, row.matchedReceiptId);
    }
  }
  return pairs;
}

function statusMap(rows: Array<{ status: string }>, idKey: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const row of rows) statuses.set(String((row as Record<string, unknown>)[idKey]), row.status);
  return statuses;
}

function compareMap(
  differences: Difference[],
  item: ComparisonCase,
  kind: Difference["kind"],
  idKey: "statementTransactionId" | "receiptId",
  expected: Map<string, string>,
  actual: Map<string, string>,
): void {
  const ids = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  for (const id of ids) {
    const before = expected.get(id) ?? "missing";
    const after = actual.get(id) ?? "missing";
    if (before !== after) {
      differences.push({ dataset: item.dataset, caseId: item.id, kind, rowId: id, expected: before, actual: after });
    }
  }
}

function buildCases(): ComparisonCase[] {
  const synthetic = reconciliationEvalDataset.map((item) => ({
    dataset: "synthetic" as const,
    id: item.id,
    statements: item.statements,
    receipts: item.receipts,
  }));
  const gateBase = generateGateCases();
  const gateRobustness = generateRobustnessGateCases();
  const gate = [...gateBase, ...gateRobustness].map((item) => ({
    dataset: "gate" as const,
    id: item.id,
    statements: item.statements,
    receipts: item.receipts,
    aliases: new Set(item.aliases),
  }));
  const dedicated = generateGateDedicatedCases().map((item) => ({
    dataset: "dedicated" as const,
    id: item.id,
    statements: item.statements,
    receipts: item.receipts,
    aliases: new Set(item.aliases),
  }));
  const cases = [...synthetic, ...gate, ...dedicated];
  if (synthetic.length !== 37) throw new Error(`Expected 37 synthetic cases, got ${synthetic.length}`);
  if (gateBase.length !== 900) throw new Error(`Expected 900 gate base cases, got ${gateBase.length}`);
  if (gateRobustness.length !== 800) throw new Error(`Expected 800 gate robustness cases, got ${gateRobustness.length}`);
  if (dedicated.length !== 1) throw new Error(`Expected 1 dedicated case, got ${dedicated.length}`);
  if (cases.length !== 1738) throw new Error(`Expected 1,738 comparison cases, got ${cases.length}`);
  return cases;
}

async function main(): Promise<void> {
  const cases = buildCases();
  const engineSource = gitShow("src/lib/reconciliation-engine.ts");
  const engineSha256 = createHash("sha256").update(engineSource).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "kakeimatch-reconciliation-1.2.1-"));
  const differences: Difference[] = [];
  const breakdown = new Map<ComparisonCase["dataset"], {
    cases: number;
    statements: number;
    receipts: number;
    automaticPairs121: number;
    automaticPairs122: number;
  }>();

  try {
    for (const file of BASE_FILES) {
      await writeFile(join(directory, basename(file)), gitShow(file));
    }
    const oldModule = await import(pathToFileURL(join(directory, "reconciliation-engine.ts")).href) as {
      RECONCILIATION_RULE_VERSION: string;
      runReconciliationEngine: (input: {
        statements: ReconciliationStatement[];
        receipts: ReconciliationReceipt[];
        aliases?: ReadonlySet<string>;
      }) => EngineResult;
    };
    if (oldModule.RECONCILIATION_RULE_VERSION !== "1.2.1") {
      throw new Error(`Base commit ${BASE_COMMIT} is not rule 1.2.1: ${oldModule.RECONCILIATION_RULE_VERSION}`);
    }

    for (const item of cases) {
      const input = { statements: item.statements, receipts: item.receipts, aliases: item.aliases };
      const before = oldModule.runReconciliationEngine(input);
      const after = runReconciliationEngine(input);
      const beforePairs = automaticPairs(before);
      const afterPairs = automaticPairs(after);

      compareMap(differences, item, "automatic_pair", "statementTransactionId", beforePairs, afterPairs);
      compareMap(differences, item, "statement_status", "statementTransactionId",
        statusMap(before.statementResults, "statementTransactionId"),
        statusMap(after.statementResults, "statementTransactionId"));
      compareMap(differences, item, "receipt_status", "receiptId",
        statusMap(before.receiptResults, "receiptId"),
        statusMap(after.receiptResults, "receiptId"));

      const row = breakdown.get(item.dataset) ?? {
        cases: 0, statements: 0, receipts: 0, automaticPairs121: 0, automaticPairs122: 0,
      };
      row.cases += 1;
      row.statements += item.statements.length;
      row.receipts += item.receipts.length;
      row.automaticPairs121 += beforePairs.size;
      row.automaticPairs122 += afterPairs.size;
      breakdown.set(item.dataset, row);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const total = [...breakdown.values()].reduce((sum, row) => ({
    cases: sum.cases + row.cases,
    statements: sum.statements + row.statements,
    receipts: sum.receipts + row.receipts,
    automaticPairs121: sum.automaticPairs121 + row.automaticPairs121,
    automaticPairs122: sum.automaticPairs122 + row.automaticPairs122,
  }), { cases: 0, statements: 0, receipts: 0, automaticPairs121: 0, automaticPairs122: 0 });
  const report = {
    method: "Extract rule 1.2.1 from git, run both engines on the same cases, diff automatic-match pairs and statuses.",
    baseCommit: BASE_COMMIT,
    baseEngineSha256: engineSha256,
    baseRuleVersion: "1.2.1",
    currentRuleVersion: RECONCILIATION_RULE_VERSION,
    breakdown: Object.fromEntries(breakdown),
    totals: total,
    differences: {
      automaticPairs: differences.filter((item) => item.kind === "automatic_pair").length,
      statementStatuses: differences.filter((item) => item.kind === "statement_status").length,
      receiptStatuses: differences.filter((item) => item.kind === "receipt_status").length,
      total: differences.length,
    },
    details: differences.slice(0, 20),
    ok: differences.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

void main();
