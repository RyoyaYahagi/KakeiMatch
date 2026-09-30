import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalReconciliationService, type LocalReceipt, type LocalStatement } from "../../apps/pwa/src/local-reconciliation";
import { LocalDataRepository } from "./local-data";
import type { ActualTransaction } from "./actual-ledger";

const repositories: LocalDataRepository[] = [];
const timestamp = "2026-09-30T00:00:00.000Z";

async function repository(): Promise<LocalDataRepository> {
  const repo = await LocalDataRepository.open(`profile-${crypto.randomUUID()}`, new IDBFactory());
  repositories.push(repo);
  return repo;
}

function makeLedger() {
  const transactions = new Map<string, ActualTransaction>();
  let failNextImport = false;
  let failNextUpdate = false;
  let importCount = 0;
  const calls: Array<{ transactionId: string; amountYen?: number; cleared: true }[]> = [];
  const ledger = {
    getRecentTransactions: async () => [], getTransactions: async () => [], getMonthlySpending: async () => 0,
    getTransactionById: async (id: string) => transactions.get(id) ?? null,
    listOpenAccounts: async () => [{ id: "account-1", name: "現金" }],
    listExpenseCategories: async () => [{ id: "category-1", name: "食費" }],
    importReceipt: async (input: { accountId: string; date: string; amountYen: number; merchant: string; categoryId: string; importedId: string }) => {
      if (failNextImport) { failNextImport = false; throw new Error("synthetic import failure"); }
      let transaction = [...transactions.values()].find((item) => (item as ActualTransaction & { importedId?: string }).importedId === input.importedId);
      if (!transaction) {
        importCount++;
        transaction = { id: `actual-${input.importedId}`, date: input.date, amountYen: input.amountYen, kind: "expense",
          payeeName: input.merchant, categoryName: "食費", accountId: input.accountId, cleared: false };
        Object.assign(transaction, { importedId: input.importedId });
        transactions.set(transaction.id, transaction);
      }
      return transaction;
    },
    applyTransactionUpdates: async (updates: Array<{ transactionId: string; amountYen?: number; cleared: true }>) => {
      calls.push(updates);
      if (failNextUpdate) { failNextUpdate = false; throw new Error("synthetic update failure"); }
      for (const update of updates) {
        const existing = transactions.get(update.transactionId);
        if (!existing) throw new Error("missing transaction");
        transactions.set(existing.id, { ...existing, ...(update.amountYen === undefined ? {} : { amountYen: update.amountYen }), cleared: true });
      }
    },
  };
  return {
    ledger, transactions, calls,
    failImport: () => { failNextImport = true; },
    failUpdate: () => { failNextUpdate = true; },
    importedCount: () => importCount,
  };
}

function makeStatement(id: string, patch: Partial<LocalStatement> = {}): LocalStatement {
  return { id, importId: "import-1", provider: "paypay", externalId: id, kind: "purchase", usedDate: "2026-09-10",
    postedDate: null, merchant: "架空ストア新宿", amountYen: 1200, paymentMethod: null, ...patch };
}

function makeReceipt(id: string, patch: Partial<LocalReceipt> = {}): LocalReceipt {
  return { id, confirmedValue: { merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1200, accountId: "account-1" },
    registration: { status: "applied", actualTransactionId: `actual-${id}` }, ...patch };
}

async function seed(repo: LocalDataRepository, statements: LocalStatement[], receipts: LocalReceipt[] = []) {
  for (const value of statements) await repo.put({ id: value.id, kind: "statement-transaction", value, updatedAt: timestamp });
  for (const value of receipts) await repo.put({ id: value.id, kind: "receipt-metadata", value, updatedAt: timestamp });
}

afterEach(() => repositories.splice(0).forEach((repo) => repo.close()));

describe("LocalReconciliationService", () => {
  it("saves immutable snapshots and batch clears automatic matches without changing receipt amount", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1200, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1")], [makeReceipt("receipt-1")]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);

    const run = await service.run();

    expect(run.statementResults[0]?.status).toBe("matched");
    expect(Object.isFrozen(run)).toBe(true);
    expect(mock.calls).toEqual([[{ transactionId: "actual-receipt-1", cleared: true }]]);
    expect(mock.transactions.get("actual-receipt-1")?.amountYen).toBe(-1200);
    expect((await service.resolutions())[0]).toMatchObject({ source: "automatic", status: "applied", receiptId: "receipt-1" });
    expect(await service.latest()).toEqual(run);
  });

  it("stores a user amount correction and an explicit merchant alias after durable decision", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿 支店", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1" } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const run = await service.run();
    expect(run.statementResults[0]?.status).toBe("needs_review");

    const resolution = await service.sameExpense(run.runId, "statement-1", "receipt-1");

    expect(resolution).toMatchObject({ source: "user", status: "applied", statementAmountYen: 1200 });
    expect(mock.transactions.get("actual-receipt-1")?.amountYen).toBe(-1200);
    expect((await repo.list("merchant-mapping"))).toHaveLength(1);
    expect((await repo.get<LocalReceipt>("receipt-1"))?.value.confirmedValue?.totalAmountYen).toBe(1150);
    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "decision_conflict" });
  });

  it("does not learn merchant aliases from automatic matches", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1200, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1", { merchant: "架空ストア（新宿）" })], [makeReceipt("receipt-1")]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);

    await service.run();

    expect(await repo.list("merchant-mapping")).toEqual([]);
  });

  it("excludes a rejected pair on the next run and requires every shown candidate to be rejected before no receipt", async () => {
    const repo = await repository();
    const mock = makeLedger();
    await seed(repo, [makeStatement("statement-1", { merchant: "別名の店", amountYen: 1500 })], [makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1500, accountId: "account-1" } })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const first = await service.run();
    expect(first.candidates).toHaveLength(1);
    await expect(service.sameExpense(first.runId, "statement-1", "not-a-candidate")).rejects.toMatchObject({ code: "candidate_unavailable" });
    await expect(service.noReceipt(first.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "candidates_remaining" });
    await service.rejectPair(first.runId, "statement-1", "receipt-1");
    const second = await service.run();
    expect(second.candidates).toHaveLength(0);
    await expect(service.noReceipt(second.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" })).resolves.toMatchObject({ status: "applied", resolution: "no_receipt" });
  });

  it("records write failures and retries with a stable imported id", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.failUpdate();
    await seed(repo, [makeStatement("statement-1", { merchant: "記録のない店", amountYen: 880 })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const run = await service.run();
    const failed = await service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" });
    expect(failed.status).toBe("failed");
    const retried = await service.retry(failed.id);
    expect(retried.status).toBe("applied");
    expect(retried.importedId).toBe("kakeimatch:statement:statement-1");
    expect(mock.importedCount()).toBe(1);
    expect(mock.transactions.size).toBe(1);
    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "decision_conflict" });
  });

  it("excludes pending and failed decisions from later snapshots", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.failImport();
    await seed(repo, [makeStatement("failed-statement", { merchant: "記録のない店", amountYen: 880 })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const first = await service.run();
    const failed = await service.noReceipt(first.runId, "failed-statement", { accountId: "account-1", categoryId: "category-1" });
    expect(failed.status).toBe("failed");
    await repo.put({ id: "statement-transaction:pending-statement", kind: "statement-transaction",
      value: makeStatement("pending-statement", { merchant: "保留中の店", amountYen: 990 }), updatedAt: timestamp });
    await repo.put({ id: "reconciliation-resolution:pending-statement", kind: "reconciliation-resolution",
      value: { ...failed, id: "reconciliation-resolution:pending-statement", statementId: "pending-statement", status: "pending" }, updatedAt: timestamp });

    const next = await service.run();

    expect(next.statementResults).toEqual([]);
    expect(next.candidates).toEqual([]);
  });

  it("does not reuse a manually matched receipt for a different statement", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿 支店", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1" } });
    await seed(repo, [makeStatement("statement-a"), makeStatement("statement-b")], [receipt]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const first = await service.run();
    expect(first.candidates).toHaveLength(2);
    await service.sameExpense(first.runId, "statement-a", "receipt-1");
    await expect(service.sameExpense(first.runId, "statement-b", "receipt-1")).rejects.toMatchObject({ code: "receipt_already_used" });

    const second = await service.run();

    expect(second.candidates).toEqual([]);
    expect(second.statementResults.map((item) => item.statementTransactionId)).toEqual(["statement-b"]);
    expect(second.statementResults[0]?.status).toBe("unmatched_statement");
    await expect(service.sameExpense(second.runId, "statement-b", "receipt-1")).rejects.toMatchObject({ code: "candidate_unavailable" });
  });

  it("persists batch automatic-match failures and retries them", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1200, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    mock.failUpdate();
    await seed(repo, [makeStatement("statement-1")], [makeReceipt("receipt-1")]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const run = await service.run();
    const failed = (await service.resolutions())[0]!;
    expect(run.statementResults[0]?.status).toBe("matched");
    expect(failed.status).toBe("failed");
    expect(mock.transactions.get("actual-receipt-1")?.cleared).toBe(false);

    const retried = await service.retry(failed.id);

    expect(retried.status).toBe("applied");
    expect(mock.transactions.get("actual-receipt-1")?.cleared).toBe(true);
  });

  it("never offers a refund as a no receipt expense and rejects stale runs and duplicate decisions", async () => {
    const repo = await repository();
    const mock = makeLedger();
    await seed(repo, [makeStatement("refund-1", { kind: "refund" })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const old = await service.run();
    const latest = await service.run();
    await expect(service.noReceipt(old.runId, "refund-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "stale_run" });
    await expect(service.sameExpense(old.runId, "refund-1", "missing-receipt")).rejects.toMatchObject({ code: "stale_run" });
    await expect(service.noReceipt(latest.runId, "refund-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "decision_unavailable" });
    await expect(service.rejectPair(latest.runId, "refund-1", "missing-receipt")).rejects.toMatchObject({ code: "candidate_unavailable" });
    expect(await service.resolutions()).toEqual([]);
  });
});
