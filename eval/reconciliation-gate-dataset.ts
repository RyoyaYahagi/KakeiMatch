/**
 * Issue #380 gate dataset: 900 base cases plus the 800 robustness cases that
 * were measured as reference values in PR #381.
 *
 * The truth pairs and their separable/ambiguous class are fixed at generation
 * time, exactly as in the PR #381 evaluation harness. This module is the single
 * owner of that generation code; the property evaluation imports it.
 */

import {
  merchantAliasKey,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "../src/lib/reconciliation-engine";

const DAY = 86_400_000;
const BASE_DATE = "2026-09-01";
export const GATE_SEEDS = 100;

export type GateTruthClass = "separable" | "ambiguous";

export type GateFamily =
  | "chain-2"
  | "chain-3"
  | "chain-5"
  | "chain-10"
  | "twin"
  | "missing"
  | "extra"
  | "threshold"
  | "alias"
  | "chain-mixed-missing"
  | "chain-mixed-extra"
  | "chain-mixed-decoy"
  | "chain-mixed-missing-decoy";

export type RobustnessVariant = "missing" | "extra" | "decoy" | "missing-decoy";

export type GateTruthPair = {
  statementId: string;
  receiptId: string;
  truthClass: GateTruthClass;
};

export type GateCase = {
  id: string;
  family: GateFamily;
  seed: number;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  aliases: string[];
  truthPairs: GateTruthPair[];
};

function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
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

function control(family: GateFamily, seed: number, date: string, amountYen: number): { statements: ReconciliationStatement[]; receipts: ReconciliationReceipt[]; truth: GateTruthPair } {
  const statementId = `s-${family}-${seed}-control`;
  const receiptId = `r-${family}-${seed}-control`;
  const merchant = `対照商店${seed}`;
  return {
    statements: [statement(statementId, merchant, amountYen, date)],
    receipts: [receipt(receiptId, merchant, amountYen, date, "acct-control")],
    truth: { statementId, receiptId, truthClass: "separable" },
  };
}

function generateChain(length: 2 | 3 | 5 | 10, seed: number): GateCase {
  const family = `chain-${length}` as GateFamily;
  const start = shiftDate(BASE_DATE, 10 + (seed % 5));
  const amount = 1000 + (seed % 90) * 10;
  const controlPair = control(family, seed, shiftDate(start, -30), 900_000 + seed * 7);
  const letters = "ABCDEFGHIJ";
  const statements: ReconciliationStatement[] = [...controlPair.statements];
  const receipts: ReconciliationReceipt[] = [...controlPair.receipts];
  const truthPairs: GateTruthPair[] = [controlPair.truth];
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

function generateTwin(seed: number): GateCase {
  const family: GateFamily = "twin";
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

function generateMissing(seed: number): GateCase {
  const family: GateFamily = "missing";
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

function generateExtra(seed: number): GateCase {
  const family: GateFamily = "extra";
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

function generateThreshold(seed: number): GateCase {
  const family: GateFamily = "threshold";
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

function generateAlias(seed: number): GateCase {
  const family: GateFamily = "alias";
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

/** The 900 base cases measured in PR #381 (chain-2/3/5/10, twin, missing, extra, threshold, alias). */
export function generateGateCases(): GateCase[] {
  const cases: GateCase[] = [];
  for (const length of [2, 3, 5, 10] as const) {
    for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateChain(length, seed));
  }
  for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateTwin(seed));
  for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateMissing(seed));
  for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateExtra(seed));
  for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateThreshold(seed));
  for (let seed = 0; seed < GATE_SEEDS; seed += 1) cases.push(generateAlias(seed));
  return cases;
}

/**
 * The 800 robustness cases measured as reference values in PR #381:
 * chain-5/10 x 100 seeds x {missing, extra, decoy, missing-decoy}.
 *
 * A missing variant removes the true receipt and marks the truth ambiguous; a
 * decoy variant adds a wrong high-score candidate while the truth remains; the
 * missing-decoy variant combines both, which is the regression this gate must
 * catch.
 */
export function generateRobustnessGateCases(): GateCase[] {
  const cases: GateCase[] = [];
  for (const length of [5, 10] as const) {
    for (let seed = 0; seed < GATE_SEEDS; seed += 1) {
      for (const variant of ["missing", "extra", "decoy", "missing-decoy"] as const) {
        const base = generateChain(length, seed);
        const target = 2 % length;
        const statementId = `s-chain-${length}-${seed}-${target}`;
        const receiptId = `r-chain-${length}-${seed}-${target}`;
        const affectedReceipt = base.receipts.find((row) => row.receiptId === receiptId)!;
        if (variant === "missing") {
          base.receipts = base.receipts.filter((row) => row.receiptId !== receiptId);
          const truth = base.truthPairs.find((row) => row.statementId === statementId)!;
          truth.truthClass = "ambiguous";
        } else if (variant === "extra") {
          base.receipts.push({
            ...affectedReceipt,
            receiptId: `${receiptId}-extra`,
            actualTransactionId: `${affectedReceipt.actualTransactionId}-extra`,
          });
        } else if (variant === "decoy") {
          // The true receipt is two days away; an exact-date decoy with the same
          // merchant and amount has the higher score but is not the truth.
          affectedReceipt.purchasedDate = shiftDate(affectedReceipt.purchasedDate, 2);
          base.receipts.push({
            ...affectedReceipt,
            receiptId: `${receiptId}-decoy`,
            actualTransactionId: `${affectedReceipt.actualTransactionId}-decoy`,
            purchasedDate: shiftDate(affectedReceipt.purchasedDate, -2),
            actualAccountId: "acct-decoy",
          });
        } else {
          // Missing truth plus a wrong high-score candidate: the most dangerous
          // combination for a false automatic match.
          base.receipts = base.receipts.filter((row) => row.receiptId !== receiptId);
          const truth = base.truthPairs.find((row) => row.statementId === statementId)!;
          truth.truthClass = "ambiguous";
          base.receipts.push({
            ...affectedReceipt,
            receiptId: `${receiptId}-decoy`,
            actualTransactionId: `${affectedReceipt.actualTransactionId}-decoy`,
            actualAccountId: "acct-decoy",
          });
        }
        base.id = `chain-mixed-${variant}-${length}-${seed}`;
        base.family = `chain-mixed-${variant}`;
        cases.push(base);
      }
    }
  }
  return cases;
}

/** 1,700 cases: the 900 base cases and the 800 robustness cases are equally weighted. */
export function generateGateDataset(): GateCase[] {
  return [...generateGateCases(), ...generateRobustnessGateCases()];
}

/**
 * Dedicated regression case for the sol review reproduction: four statements
 * and four receipts share the same amount, date and merchant, so every pair is
 * a candidate and every statement has more than three candidates. It is kept
 * outside the 1,700-case count and checked separately for candidate-set
 * equality against the frozen 1.2.0 engine.
 */
export function generateGateDedicatedCases(): GateCase[] {
  const date = "2026-01-01";
  const amount = 1000;
  const merchant = "同一商店";
  return [{
    id: "dedicated-all-conflict-4x4",
    family: "twin",
    seed: 0,
    statements: [0, 1, 2, 3].map((index) => statement(`s-dedicated-${index}`, merchant, amount, date)),
    receipts: [0, 1, 2, 3].map((index) => receipt(`r-dedicated-${index}`, merchant, amount, date, `acct-dedicated-${index}`)),
    aliases: [],
    truthPairs: [],
  }];
}

export const GATE_ROBUSTNESS_VARIANTS: readonly RobustnessVariant[] = ["missing", "extra", "decoy", "missing-decoy"];

export const GATE_FAMILIES: readonly GateFamily[] = [
  "chain-2", "chain-3", "chain-5", "chain-10",
  "twin", "missing", "extra", "threshold", "alias",
  "chain-mixed-missing", "chain-mixed-extra", "chain-mixed-decoy", "chain-mixed-missing-decoy",
];
