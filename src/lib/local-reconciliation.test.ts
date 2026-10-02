import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalReconciliationService, type LocalReceipt, type LocalResolution, type LocalStatement } from "../../apps/pwa/src/local-reconciliation";
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
  const accounts = [{ id: "account-1", name: "カード", accountType: "credit_card" as const, closed: false },
    { id: "account-2", name: "別カード", accountType: "credit_card" as const, closed: false }];
  let failNextImport = false;
  let failNextUpdate = false;
  let importCount = 0;
  const calls: Array<{ transactionId: string; amountYen?: number; cleared: true }[]> = [];
  const ledger = {
    getRecentTransactions: async () => [], getTransactions: async ({ startDate, endDate }: { startDate: string; endDate: string }) =>
      [...transactions.values()].filter(item => item.date >= startDate && item.date <= endDate), getMonthlySpending: async () => 0,
    getTransactionById: async (id: string) => transactions.get(id) ?? null,
    listAccounts: async () => accounts,
    listOpenAccounts: async () => accounts.map(({ id, name, accountType }) => ({ id, name, accountType })),
    listExpenseCategories: async () => [{ id: "category-1", name: "食費" }],
    importReceipt: async (input: { accountId: string; date: string; amountYen: number; merchant: string; categoryId: string; importedId: string }) => {
      if (failNextImport) { failNextImport = false; throw new Error("synthetic import failure"); }
      let transaction = [...transactions.values()].find((item) => (item as ActualTransaction & { importedId?: string }).importedId === input.importedId);
      if (!transaction) {
        importCount++;
        transaction = { id: `actual-${input.importedId}`, date: input.date, amountYen: input.amountYen, kind: "expense",
          payeeName: input.merchant.trim(), categoryName: "食費", accountId: input.accountId, cleared: false };
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
    ledger, transactions, calls, accounts,
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
  const imports = new Map(statements.map(statement => [statement.importId, statement.provider]));
  for (const [id, provider] of imports) await repo.put({ id, kind: "statement-import",
    value: { provider, accountId: "account-1", fileHash: "a".repeat(64), encoding: "utf-8", headerSignature: "test",
      totalRows: 0, excludedRows: 0, duplicateRowsInFile: 0, createdAt: timestamp }, updatedAt: timestamp });
  for (const value of statements) await repo.put({ id: value.id, kind: "statement-transaction", value, updatedAt: timestamp });
  for (const value of receipts) await repo.put({ id: value.id, kind: "receipt-metadata", value, updatedAt: timestamp });
}
function createLocalReconciliationService(repo: LocalDataRepository, mock: ReturnType<typeof makeLedger>) {
  return new LocalReconciliationService(repo, mock.ledger as never, async () => "paypay");
}

afterEach(() => repositories.splice(0).forEach((repo) => repo.close()));

describe("LocalReconciliationService", () => {
  it("saves immutable snapshots and batch clears automatic matches without changing receipt amount", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1200, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1")], [makeReceipt("receipt-1")]);
    const service = createLocalReconciliationService(repo, mock);

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
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    expect(run.statementResults[0]?.status).toBe("needs_review");

    const resolution = await service.sameExpense(run.runId, "statement-1", "receipt-1");

    expect(resolution).toMatchObject({ source: "user", status: "applied", statementAmountYen: 1200 });
    expect(mock.transactions.get("actual-receipt-1")?.amountYen).toBe(-1200);
    expect((await repo.list("merchant-mapping"))).toHaveLength(0);
    expect((await repo.get<LocalReceipt>("receipt-1"))?.value.confirmedValue?.totalAmountYen).toBe(1150);
    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "decision_conflict" });
  });

  it("does not learn merchant aliases from automatic matches", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1500, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1200, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1", { merchant: "架空ストア（新宿）" })], [makeReceipt("receipt-1")]);
    const service = createLocalReconciliationService(repo, mock);

    await service.run();

    expect(await repo.list("merchant-mapping")).toEqual([]);
  });

  it("uses eligible native Actual expenses as candidates and clears exact matches", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("native-expense", { id: "native-expense", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1")]);
    const service = createLocalReconciliationService(repo, mock);

    const run = await service.run();

    expect(run.statementResults[0]?.status).toBe("matched");
    expect((await service.resolutions())[0]).toMatchObject({ receiptId: "actual:native-expense", source: "automatic", status: "applied" });
    expect(mock.transactions.get("native-expense")?.cleared).toBe(true);
  });

  it("clears an exact split transaction without changing its amount", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("split-expense", { id: "split-expense", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false, isSplit: true });
    await seed(repo, [makeStatement("statement-1")]);
    const service = createLocalReconciliationService(repo, mock);

    const run = await service.run();

    expect(run.statementResults[0]?.status).toBe("matched");
    expect((await service.resolutions())[0]).toMatchObject({ status: "applied", actualTransactionId: "split-expense" });
    expect(mock.transactions.get("split-expense")).toMatchObject({ amountYen: -1200, cleared: true, isSplit: true });
  });

  it("rejects amount correction for a split transaction before saving a resolution", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("split-expense", { id: "split-expense", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false, isSplit: true });
    await seed(repo, [makeStatement("statement-1")], [makeReceipt("receipt-1", { confirmedValue: {
      merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1",
    }, registration: { status: "applied", actualTransactionId: "split-expense" } })]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();

    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "split_amount_adjustment_unsupported" });
    expect(await service.resolutions()).toEqual([]);
    expect(mock.transactions.get("split-expense")?.amountYen).toBe(-1150);
  });

  it("hydrates a legacy failed same-expense resolution from its confirmed receipt and Actual transaction", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: {
      merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1",
    } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    const legacy: LocalResolution = {
      id: "reconciliation-resolution:statement-1", runId: run.runId, statementId: "statement-1", resolution: "same_expense",
      source: "user", receiptId: "receipt-1", categoryId: null, accountId: null, statementAmountYen: 1200, importedId: null,
      status: "failed", actualTransactionId: "actual-receipt-1", errorCode: "actual_apply_failed", createdAt: timestamp, updatedAt: timestamp,
    };
    await repo.put({ id: legacy.id, kind: "reconciliation-resolution", value: legacy, updatedAt: timestamp });

    const retried = await service.retry(legacy.id);

    expect(retried).toMatchObject({ status: "applied", actualSnapshot: {
      date: "2026-09-10", amountYen: -1150, payeeName: "架空ストア新宿", accountId: "account-1",
    } });
    expect(mock.transactions.get("actual-receipt-1")).toMatchObject({ amountYen: -1200, cleared: true });
  });

  it("does not clear a legacy automatic resolution if its statement amount is no longer exact", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: {
      merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1",
    } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    const legacy: LocalResolution = {
      id: "reconciliation-resolution:statement-1", runId: run.runId, statementId: "statement-1", resolution: "same_expense",
      source: "automatic", receiptId: "receipt-1", categoryId: null, accountId: null, statementAmountYen: 1200, importedId: null,
      status: "failed", actualTransactionId: "actual-receipt-1", errorCode: "actual_apply_failed", createdAt: timestamp, updatedAt: timestamp,
    };
    await repo.put({ id: legacy.id, kind: "reconciliation-resolution", value: legacy, updatedAt: timestamp });

    const retried = await service.retry(legacy.id);

    expect(retried).toMatchObject({ status: "failed", errorCode: "actual_readback_mismatch" });
    expect(mock.transactions.get("actual-receipt-1")).toMatchObject({ amountYen: -1150, cleared: false });
  });

  it("compares no-receipt readback after Actual trims the statement merchant", async () => {
    const repo = await repository();
    const mock = makeLedger();
    await seed(repo, [makeStatement("statement-1", { merchant: "  記録のない店  ", amountYen: 880 })]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();

    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" }))
      .resolves.toMatchObject({ status: "applied", actualTransactionId: "actual-kakeimatch:statement:statement-1" });
    expect(mock.transactions.get("actual-kakeimatch:statement:statement-1")?.payeeName).toBe("記録のない店");
  });

  it("scopes native Actual candidates to the mapped account and excludes cleared or previously resolved imports", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("wrong-account", { id: "wrong-account", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-2", cleared: false });
    mock.transactions.set("already-cleared", { id: "already-cleared", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: true });
    mock.transactions.set("already-imported", { id: "already-imported", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false, importedId: "resolved-import" });
    await seed(repo, [makeStatement("statement-1")]);
    await repo.put({ id: "reconciliation-resolution:old-statement", kind: "reconciliation-resolution", value: {
      id: "reconciliation-resolution:old-statement", runId: "old-run", statementId: "old-statement", resolution: "no_receipt",
      source: "user", receiptId: null, categoryId: "category-1", accountId: "account-1", statementAmountYen: 1200,
      importedId: "resolved-import", status: "applied", actualTransactionId: "some-other-transaction", errorCode: null,
      createdAt: timestamp, updatedAt: timestamp,
    } satisfies LocalResolution, updatedAt: timestamp });
    const service = createLocalReconciliationService(repo, mock);

    const run = await service.run();

    expect(run.statementResults).toMatchObject([{ status: "unmatched_statement" }]);
    expect(run.candidates).toEqual([]);
    expect(run.receiptResults).toEqual([]);
  });

  it.each([
    ["date", { date: "2026-09-11" }],
    ["payee", { payeeName: "別の店舗" }],
    ["account", { accountId: "account-2" }],
  ] as const)("rejects a manual decision after the Actual %s changes", async (_field, patch) => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1" } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    mock.transactions.set("actual-receipt-1", { ...mock.transactions.get("actual-receipt-1")!, ...patch });

    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "stale_run" });
    expect(await service.resolutions()).toEqual([]);
  });

  it("invalidates a run when an account provider mapping changes", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1" } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    let provider: "paypay" | "smbc_card" = "paypay";
    const service = new LocalReconciliationService(repo, mock.ledger as never, async () => provider);
    const run = await service.run();
    provider = "smbc_card";

    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "stale_run" });
  });

  it("invalidates a run when linked receipt confirmation changes without an Actual write", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: {
      merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1",
    } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    await repo.put({ id: "receipt-1", kind: "receipt-metadata", value: {
      ...receipt,
      confirmedValue: { ...receipt.confirmedValue!, merchant: "架空ストア新宿 支店" },
    }, updatedAt: timestamp });

    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "stale_run" });
  });

  it("does not reuse a no-receipt Actual expense for a later similar statement", async () => {
    const repo = await repository();
    const mock = makeLedger();
    await seed(repo, [makeStatement("statement-1", { merchant: "記録のない店", amountYen: 880 })]);
    const service = createLocalReconciliationService(repo, mock);
    const first = await service.run();
    const recorded = await service.noReceipt(first.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" });
    expect(recorded).toMatchObject({ status: "applied", actualTransactionId: "actual-kakeimatch:statement:statement-1" });
    await repo.put({ id: "statement-2", kind: "statement-transaction",
      value: makeStatement("statement-2", { merchant: "記録のない店", amountYen: 880 }), updatedAt: timestamp });

    const second = await service.run();

    expect(second.statementResults).toEqual([expect.objectContaining({ statementTransactionId: "statement-2", status: "unmatched_statement" })]);
    expect(second.candidates).toEqual([]);
    expect(second.receiptResults).toEqual([]);
  });

  it("rejects a user decision when its saved Actual snapshot changed after the run", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1150,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const receipt = makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿 支店", purchasedDate: "2026-09-10", totalAmountYen: 1150, accountId: "account-1" } });
    await seed(repo, [makeStatement("statement-1")], [receipt]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    mock.transactions.set("actual-receipt-1", { ...mock.transactions.get("actual-receipt-1")!, amountYen: -1100 });

    await expect(service.sameExpense(run.runId, "statement-1", "receipt-1")).rejects.toMatchObject({ code: "stale_run" });
    expect((await service.resolutions())).toEqual([]);
  });

  it("excludes a rejected pair on the next run and requires every shown candidate to be rejected before no receipt", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-receipt-1", { id: "actual-receipt-1", date: "2026-09-10", amountYen: -1500,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    await seed(repo, [makeStatement("statement-1", { merchant: "別名の店", amountYen: 1500 })], [makeReceipt("receipt-1", { confirmedValue: { merchant: "架空ストア新宿", purchasedDate: "2026-09-10", totalAmountYen: 1500, accountId: "account-1" } })]);
    const service = createLocalReconciliationService(repo, mock);
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
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    const failed = await service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" });
    expect(failed.status).toBe("failed");
    const retried = await service.retry(failed.id);
    expect(retried.status).toBe("applied");
    expect(retried.importedId).toBe("kakeimatch:statement:statement-1");
    expect(mock.importedCount()).toBe(1);
    expect(mock.transactions.size).toBe(1);
    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "stale_run" });
  });

  it("excludes pending and failed decisions from later snapshots", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.failImport();
    await seed(repo, [makeStatement("failed-statement", { merchant: "記録のない店", amountYen: 880 })]);
    const service = createLocalReconciliationService(repo, mock);
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
    const service = createLocalReconciliationService(repo, mock);
    const first = await service.run();
    expect(first.candidates).toHaveLength(2);
    await service.sameExpense(first.runId, "statement-a", "receipt-1");
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
    const service = createLocalReconciliationService(repo, mock);
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
    const service = createLocalReconciliationService(repo, mock);
    const old = await service.run();
    const latest = await service.run();
    await expect(service.noReceipt(old.runId, "refund-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "stale_run" });
    await expect(service.sameExpense(old.runId, "refund-1", "missing-receipt")).rejects.toMatchObject({ code: "stale_run" });
    await expect(service.noReceipt(latest.runId, "refund-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "decision_unavailable" });
    await expect(service.rejectPair(latest.runId, "refund-1", "missing-receipt")).rejects.toMatchObject({ code: "candidate_unavailable" });
    expect(await service.resolutions()).toEqual([]);
  });
});
