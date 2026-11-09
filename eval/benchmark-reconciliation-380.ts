/**
 * Issue #380 performance check: 200 statements, 200 receipts and about 2,000
 * eligible candidate edges split over 20 independent components of 10×10.
 *
 * The input is synthetic and intentionally dense inside each component (same
 * amount and merchant, three nearby dates). It measures the assignment, Δ and
 * lexicographic work at a realistic row/edge count, not the synthetic chain
 * coverage. Run with `pnpm eval:reconciliation-380-benchmark`.
 */

import { performance } from "node:perf_hooks";
import {
  inspectReconciliationAssignment,
  runReconciliationEngine,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";

const DAY = 86_400_000;
const BASE_DATE = "2026-09-01";
const COMPONENTS = 20;
const COMPONENT_SIZE = 10;
const RUNS = 5;

function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

function buildCase(): { statements: ReconciliationStatement[]; receipts: ReconciliationReceipt[] } {
  const statements: ReconciliationStatement[] = [];
  const receipts: ReconciliationReceipt[] = [];
  for (let component = 0; component < COMPONENTS; component += 1) {
    const amountYen = 1000 + component * 1000;
    const merchant = `ベンチ商店${component}`;
    const start = shiftDate(BASE_DATE, component % 20);
    for (let index = 0; index < COMPONENT_SIZE; index += 1) {
      const date = shiftDate(start, index % 3);
      const suffix = `${String(component).padStart(3, "0")}-${String(index).padStart(3, "0")}`;
      statements.push({
        statementTransactionId: `s-${suffix}`, provider: "synthetic", externalId: null,
        kind: "purchase", usedDate: date, postedDate: null, merchant, amountYen, paymentMethod: null,
      });
      receipts.push({
        receiptId: `r-${suffix}`, actualTransactionId: `actual-${suffix}`, merchant,
        purchasedDate: date, amountYen, actualAccountId: `acct-${index % 5}`,
      });
    }
  }
  return { statements, receipts };
}

function measure(run: () => unknown): { min: number; median: number; max: number; runs: number[] } {
  run();
  const values: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now();
    run();
    values.push(performance.now() - start);
  }
  values.sort((left, right) => left - right);
  return { min: values[0]!, median: values[Math.floor(values.length / 2)]!, max: values[values.length - 1]!, runs: values };
}

const input = buildCase();
const engine = measure(() => runReconciliationEngine(input));
const diagnostics = measure(() => inspectReconciliationAssignment(input));
const result = runReconciliationEngine(input);
console.log(JSON.stringify({
  dataset: "eval/benchmark-reconciliation-380.ts",
  statements: input.statements.length,
  receipts: input.receipts.length,
  eligibleEdges: COMPONENTS * COMPONENT_SIZE * COMPONENT_SIZE,
  components: COMPONENTS,
  componentSize: COMPONENT_SIZE,
  automaticMatches: result.statementResults.filter((row) => row.status === "matched").length,
  runReconciliationEngineMs: engine,
  inspectReconciliationAssignmentMs: diagnostics,
}, null, 2));
