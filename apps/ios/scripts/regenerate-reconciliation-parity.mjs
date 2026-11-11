import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runReconciliationEngine } from "../../../src/lib/reconciliation-engine.ts";
import { runReconciliationEngine as runFrozenEngine } from "../../../eval/frozen/reconciliation-engine-1.2.0.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(scriptDirectory, "../KakeiMatchTests/Fixtures/reconciliation-parity.json");

const statement = (id, merchant, amountYen, usedDate) => ({
  id, importId: "synthetic", provider: "paypay_card", externalId: null, kind: "purchase",
  usedDate, postedDate: null, merchant, amountYen, paymentMethod: null,
  sourceFingerprint: "synthetic", duplicateOrdinal: 1,
});
const receipt = (receiptId, merchant, amountYen, purchasedDate, account = `account-${receiptId}`) => ({
  receiptId, actualTransactionId: `actual-${receiptId}`, merchant, purchasedDate, amountYen, actualAccountId: account,
});

function shiftDate(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function chainCase(length) {
  const family = `global-chain-${length}`;
  const start = "2026-09-10";
  const amount = 1000 + length * 10;
  const letters = "ABCDEFGHIJ";
  const statements = [statement(`s-${family}-control`, "対照商店", 900000 + length, shiftDate(start, -30))];
  const receipts = [receipt(`r-${family}-control`, "対照商店", 900000 + length, shiftDate(start, -30))];
  for (let index = 0; index < length; index += 1) {
    const date = shiftDate(start, index * 2);
    const merchant = `架空商店${letters[index]}`;
    statements.push(statement(`s-${family}-${index}`, merchant, amount, date));
    receipts.push(receipt(`r-${family}-${index}`, merchant, amount, date, `acct-${index}`));
  }
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

function twinCase() {
  const family = "global-twin";
  const date = "2026-09-05";
  const statements = [statement(`s-${family}-control`, "対照商店", 900001, shiftDate(date, -30)), statement(`s-${family}-truth`, "双子商店", 1201, date)];
  const receipts = [receipt(`r-${family}-control`, "対照商店", 900001, shiftDate(date, -30)),
    receipt(`r-${family}-truth`, "双子商店", 1201, date), receipt(`r-${family}-twin`, "双子商店", 1201, date)];
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

function extraCase() {
  const family = "global-extra";
  const date = "2026-09-05";
  const statements = [statement(`s-${family}-control`, "対照商店", 900002, shiftDate(date, -30)), statement(`s-${family}-truth`, "余分商店A", 1401, date)];
  const receipts = [receipt(`r-${family}-control`, "対照商店", 900002, shiftDate(date, -30)),
    receipt(`r-${family}-truth`, "余分商店A", 1401, date), receipt(`r-${family}-extra`, "余分商店B", 1401, shiftDate(date, 2))];
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

function thresholdCase() {
  const family = "global-threshold";
  const date = "2026-09-05";
  const statements = [statement(`s-${family}-control`, "対照商店", 900003, shiftDate(date, -30)), statement(`s-${family}-truth`, "湖畔ベーカリー新宿", 1501, date)];
  const receipts = [receipt(`r-${family}-control`, "対照商店", 900003, shiftDate(date, -30)),
    receipt(`r-${family}-truth`, "湖畔ベーカリー新宿", 1501, date), receipt(`r-${family}-below`, "湖畔ベーカリー２号店", 1501, shiftDate(date, 2))];
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

function missingCase() {
  const family = "global-missing";
  const date = "2026-09-05";
  const statements = [statement(`s-${family}-control`, "対照商店", 900004, shiftDate(date, -30)), statement(`s-${family}-missing`, "欠落商店", 1301, date)];
  const receipts = [receipt(`r-${family}-control`, "対照商店", 900004, shiftDate(date, -30)), receipt(`r-${family}-decoy`, "無関係商店", 1301, date)];
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

function rankingConflictCase() {
  const family = "ranking-conflict";
  const date = "2026-09-10";
  const statements = [
    statement(`s-${family}-1`, "架空商店アルファ", 1000, date),
    statement(`s-${family}-2`, "無関係カフェ", 1000, date),
  ];
  const receipts = [
    receipt(`r-${family}-1`, "架空商店アルファ", 1000, date, "acct-1"),
    receipt(`r-${family}-2`, "架空商店アルファ", 1000, shiftDate(date, 1), "acct-2"),
  ];
  return {
    id: family, statements, receipts,
    preferred: { [`s-${family}-1`]: [], [`s-${family}-2`]: ["acct-1"] },
  };
}

function allConflictCase() {
  const family = "global-all-conflict-4x4";
  const date = "2026-01-01";
  const amount = 1000;
  const statements = [0, 1, 2, 3].map((index) => statement(`s-${family}-${index}`, "同一商店", amount, date));
  const receipts = [0, 1, 2, 3].map((index) => receipt(`r-${family}-${index}`, "同一商店", amount, date, `acct-${index}`));
  return { id: family, statements, receipts, preferred: Object.fromEntries(statements.map((row) => [row.id, []])) };
}

/**
 * Issue #389 ranking guard. The assignment pairs s1 with the lower-scored r2,
 * so the guard decides whether r2 becomes the first row: an 82 yen amount gap
 * is just over 0.15, an 81 yen gap is just under it. Both receipts are three
 * days away, so automatic matching cannot absorb the case.
 */
function rankingGuardCases() {
  const family = "ranking-guard";
  const date = "2026-09-10";
  const make = (label, delta) => ({
    id: `${family}-${label}`,
    statements: [
      statement(`s-${family}-${label}-1`, "架空商店アルファ", 10000, date),
      statement(`s-${family}-${label}-2`, "架空商店アルファ", 10000, date),
    ],
    receipts: [
      receipt(`r-${family}-${label}-1`, "架空商店アルファ", 10000, shiftDate(date, -3), "acct-1"),
      receipt(`r-${family}-${label}-2`, "架空商店アルファ", 10000 - delta, shiftDate(date, -3), "acct-2"),
    ],
    preferred: { [`s-${family}-${label}-1`]: [], [`s-${family}-${label}-2`]: ["acct-1"] },
  });
  return [make("blocked", 82), make("promoted", 81)];
}

/**
 * Issue #389 exact-threshold evidence. At 4400 yen the tolerance is 132 yen.
 * r1 is 108 yen off, so its amount score is 2/11 and its review score is
 * 0.55 * 2/11 + 0.15 (date) + 0.05 (merchant) = 0.3. r2 is exactly at the
 * tolerance (amount score 0), has zero merchant similarity, and shares the
 * date, so its review score is exactly 0.15. The binary64 gap is exactly
 * 0.15, which must promote. Moving r2 one day away gives 0.13125 and a
 * 0.16875 gap, which must not promote.
 */
function rankingGuardBoundaryCases() {
  const family = "ranking-guard-boundary";
  const make = (label, partnerDate) => ({
    id: `${family}-${label}`,
    statements: [
      statement(`s-${family}-${label}-1`, "架空商店アルファ", 4400, "2026-09-10"),
      statement(`s-${family}-${label}-2`, "架空商店アルファ", 4400, "2026-09-10"),
    ],
    receipts: [
      receipt(`r-${family}-${label}-1`, "架空商店アルファ", 4292, "2026-09-10", "acct-1"),
      receipt(`r-${family}-${label}-2`, "無関係薬局", 4268, partnerDate, "acct-2"),
    ],
    preferred: { [`s-${family}-${label}-1`]: [], [`s-${family}-${label}-2`]: ["acct-1"] },
  });
  return [make("exact", "2026-09-10"), make("above", "2026-09-09")];
}

const additionalCases = [
  chainCase(2), chainCase(3), chainCase(5), chainCase(10),
  twinCase(), extraCase(), thresholdCase(), missingCase(),
  rankingConflictCase(), allConflictCase(), ...rankingGuardCases(), ...rankingGuardBoundaryCases(),
];

function toEngineInput(item) {
  return {
    statements: item.statements.map((row) => ({
      statementTransactionId: row.id, provider: row.provider, externalId: row.externalId ?? null, kind: row.kind,
      usedDate: row.usedDate, postedDate: row.postedDate ?? null, merchant: row.merchant, amountYen: row.amountYen,
      paymentMethod: row.paymentMethod ?? null, preferredAccountIds: item.preferred[row.id] ?? [],
    })),
    receipts: item.receipts.map((row) => ({
      receiptId: row.receiptId, actualTransactionId: row.actualTransactionId, merchant: row.merchant,
      purchasedDate: row.purchasedDate, amountYen: row.amountYen, actualAccountId: row.actualAccountId,
    })),
  };
}

const existing = JSON.parse(await readFile(fixturePath, "utf8"));
const byId = new Map(existing.map((item) => [item.id, item]));
for (const item of additionalCases) byId.set(item.id, item);
const cases = [...byId.values()];
function candidateSets(result) {
  const sets = new Map();
  for (const candidate of result.candidates) {
    const set = sets.get(candidate.statementTransactionId) ?? new Set();
    set.add(candidate.receiptId);
    sets.set(candidate.statementTransactionId, set);
  }
  return sets;
}
for (const item of cases) {
  const input = toEngineInput(item);
  const result = runReconciliationEngine(input);
  const old = runFrozenEngine(input);
  const newSets = candidateSets(result);
  const oldSets = candidateSets(old);
  for (const row of item.statements) {
    const newSet = newSets.get(row.id) ?? new Set();
    const oldSet = oldSets.get(row.id) ?? new Set();
    const missing = [...oldSet].filter((receiptId) => !newSet.has(receiptId));
    const extra = [...newSet].filter((receiptId) => !oldSet.has(receiptId));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`${item.id}/${row.id}: candidate set differs from 1.2.0 (missing=${missing.join(",")} extra=${extra.join(",")})`);
    }
  }
  item.expected = {
    ruleVersion: result.ruleVersion,
    candidates: result.candidates,
    statementResults: result.statementResults,
    receiptResults: result.receiptResults,
  };
}
if (cases.length !== 287) throw new Error(`Expected 287 parity cases, got ${cases.length}`);
await writeFile(fixturePath, `${JSON.stringify(cases)}\n`);
console.log(JSON.stringify({ fixturePath, caseCount: cases.length, ruleVersion: cases[0].expected.ruleVersion,
  autoMatches: cases.reduce((sum, item) => sum + item.expected.statementResults.filter((row) => row.status === "matched").length, 0) }));
