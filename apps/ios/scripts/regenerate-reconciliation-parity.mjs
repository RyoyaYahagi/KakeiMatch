import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runReconciliationEngine } from "../../../src/lib/reconciliation-engine.ts";

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

const additionalCases = [
  chainCase(2), chainCase(3), chainCase(5), chainCase(10),
  twinCase(), extraCase(), thresholdCase(), missingCase(),
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
for (const item of cases) {
  const result = runReconciliationEngine(toEngineInput(item));
  item.expected = {
    ruleVersion: result.ruleVersion,
    candidates: result.candidates,
    statementResults: result.statementResults,
    receiptResults: result.receiptResults,
  };
}
if (cases.length !== 281) throw new Error(`Expected 281 parity cases, got ${cases.length}`);
await writeFile(fixturePath, `${JSON.stringify(cases)}\n`);
console.log(JSON.stringify({ fixturePath, caseCount: cases.length, ruleVersion: cases[0].expected.ruleVersion,
  autoMatches: cases.reduce((sum, item) => sum + item.expected.statementResults.filter((row) => row.status === "matched").length, 0) }));
