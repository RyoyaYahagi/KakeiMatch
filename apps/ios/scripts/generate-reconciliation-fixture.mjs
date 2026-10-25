import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runReconciliationEngine } from "../../../src/lib/reconciliation-engine.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const inputPath = resolve(scriptDirectory, "../KakeiMatch/Data/InMemory/Fixtures/migration.json");
const outputPath = resolve(scriptDirectory, "../KakeiMatch/Data/InMemory/Fixtures/reconciliation.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const now = input.now;
const accountIdByName = new Map(input.accounts.map((account, index) => [account.name, `fixture-account-${index}`]));
const providerByAccountId = new Map(input.accounts.map((account, index) => [`fixture-account-${index}`, account.provider]));
const dateString = (value) => value.replaceAll("/", "-");
const shiftDate = (value, days) => new Date(Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const transactionId = (index) => `fixture-transaction-${String(index).padStart(3, "0")}`;

const statements = input.statement.map((statement, index) => ({
  statementTransactionId: `fixture-statement-${index}`,
  provider: "paypay_card",
  externalId: null,
  kind: "purchase",
  usedDate: dateString(statement.date),
  postedDate: null,
  merchant: statement.merchant,
  amountYen: statement.amountYen,
  paymentMethod: null,
  preferredAccountIds: ["fixture-account-0"],
}));
const firstStatementDate = statements.reduce((date, statement) => statement.usedDate < date ? statement.usedDate : date, statements[0].usedDate);
const lastStatementDate = statements.reduce((date, statement) => statement.usedDate > date ? statement.usedDate : date, statements[0].usedDate);
const startDate = shiftDate(firstStatementDate, -7);
const endDate = shiftDate(lastStatementDate, 7);
const transactions = input.transactions.map((transaction, index) => ({
  ...transaction,
  id: transactionId(index),
  accountId: accountIdByName.get(transaction.account),
}));
const inStatementWindow = (transaction) => transaction.date >= startDate && transaction.date <= endDate;
const engineReceipts = transactions
  .filter((transaction) => transaction.type === "expense" && inStatementWindow(transaction)
    && input.accounts[Number(transaction.accountId.slice("fixture-account-".length))].type !== "cash")
  .map((transaction) => ({
    receiptId: `actual:${transaction.id}`,
    actualTransactionId: transaction.id,
    merchant: transaction.payee,
    purchasedDate: transaction.date,
    amountYen: transaction.amountYen,
    actualAccountId: transaction.accountId,
  }));
const waitingReceiptIds = new Set(transactions
  .filter((transaction) => transaction.type === "expense" && inStatementWindow(transaction)
    && providerByAccountId.get(transaction.accountId) === "paypay_card")
  .map((transaction) => `actual:${transaction.id}`));
const engineResult = runReconciliationEngine({ statements, receipts: engineReceipts });
const results = {
  ruleVersion: engineResult.ruleVersion,
  candidates: engineResult.candidates,
  statementResults: engineResult.statementResults,
  receiptResults: engineResult.receiptResults.filter((result) => waitingReceiptIds.has(result.receiptId)),
};

const resolutions = results.statementResults.flatMap((result) => {
  if (result.status !== "matched" || !result.matchedReceiptId) return [];
  const transaction = transactions.find((row) => `actual:${row.id}` === result.matchedReceiptId);
  const statement = statements.find((row) => row.statementTransactionId === result.statementTransactionId);
  if (!transaction || !statement) throw new Error(`Automatic match source is missing: ${result.statementTransactionId}`);
  return [{
    id: `reconciliation-resolution:${statement.statementTransactionId}`,
    runId: "fixture-run",
    statementId: statement.statementTransactionId,
    resolution: "same_expense",
    source: "automatic",
    receiptId: result.matchedReceiptId,
    categoryId: null,
    accountId: null,
    statementAmountYen: statement.amountYen,
    importedId: null,
    status: "applied",
    actualTransactionId: transaction.id,
    actualSnapshot: {
      date: transaction.date,
      amountYen: -transaction.amountYen,
      payeeName: transaction.payee,
      accountId: transaction.accountId,
      isSplit: false,
      cleared: false,
    },
    statementSnapshot: { usedDate: statement.usedDate, merchant: statement.merchant, kind: statement.kind },
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  }];
});
const run = {
  runId: "fixture-run",
  createdAt: now,
  completedAt: now,
  ...results,
};
const output = { run, resolutions };

if (statements.length !== 7 || results.statementResults.filter((row) => row.status === "matched").length !== 4
  || results.statementResults.filter((row) => row.status === "needs_review").length !== 1
  || results.statementResults.filter((row) => row.status === "unmatched_statement").length !== 2) {
  throw new Error(`Unexpected statement result counts: ${JSON.stringify(results.statementResults.map(({ status }) => status))}`);
}
if (resolutions.length !== 4) throw new Error(`Expected four automatic resolutions; got ${resolutions.length}`);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath: resolve(outputPath),
  statements: results.statementResults.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {}),
  candidates: results.candidates.length,
  receiptResults: results.receiptResults.length,
  resolutions: resolutions.length,
}));
