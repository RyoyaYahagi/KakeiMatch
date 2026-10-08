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
    { id: "account-2", name: "別カード", accountType: "credit_card" as const, closed: false },
    { id: "account-cash", name: "財布", accountType: "cash" as const, closed: false }];
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
    setSpendingExclusion: async (id: string, excluded: boolean) => { transactions.set(id, { ...transactions.get(id)!, excludedFromSpending: excluded }); },
    createTransfer: async (input: { sourceAccountId: string; destinationAccountId: string; date: string; amountYen: number; memo: string | null; importedId: string }) => {
      let transaction = [...transactions.values()].find(row => row.importedId === input.importedId);
      if (!transaction) {
        importCount++;
        transaction = { id: `transfer-${input.importedId}`, date: input.date, amountYen: -input.amountYen, kind: "transfer", payeeName: null,
          categoryName: null, accountId: input.sourceAccountId, transferAccountId: input.destinationAccountId, cleared: false, importedId: input.importedId };
        transactions.set(transaction.id, transaction);
      }
      return transaction;
    },
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

async function seed(repo: LocalDataRepository, statements: LocalStatement[], receipts: LocalReceipt[] = [], legacyAccountId?: string) {
  const imports = new Map(statements.map(statement => [statement.importId, statement.provider]));
  for (const [id, provider] of imports) await repo.put({ id, kind: "statement-import",
    value: { provider, ...(legacyAccountId ? { accountId: legacyAccountId } : {}), fileHash: "a".repeat(64), encoding: "utf-8", headerSignature: "test",
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

  it("excludes cash, cleared, or previously resolved Actual expenses from candidates", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("cash-expense", { id: "cash-expense", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-cash", cleared: false });
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

  it("matches a provider-only import without any payment source mapping", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.transactions.set("actual-other-card", { id: "actual-other-card", date: "2026-09-10", amountYen: -1200,
      kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-2", cleared: false });
    await seed(repo, [makeStatement("statement-1")]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);

    const run = await service.run();

    expect(run.statementResults).toMatchObject([{ status: "matched", matchedReceiptId: "actual:actual-other-card" }]);
    expect(run.statementResults[0]?.reasonCodes).not.toContain("provider_account_unmapped");
    expect((await service.resolutions())[0]).toMatchObject({ source: "automatic", status: "applied", accountId: null });
    expect(mock.transactions.get("actual-other-card")).toMatchObject({ accountId: "account-2", amountYen: -1200, cleared: true });
  });

  it("returns the same matching result for legacy account-scoped and provider-only imports", async () => {
    const results = [];
    for (const legacyAccountId of [undefined, "account-1"]) {
      const repo = await repository();
      const mock = makeLedger();
      mock.transactions.set("actual-a", { id: "actual-a", date: "2026-09-10", amountYen: -1200,
        kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-2", cleared: false });
      mock.transactions.set("actual-b", { id: "actual-b", date: "2026-09-12", amountYen: -900,
        kind: "expense", payeeName: "別の店", categoryName: null, accountId: "account-1", cleared: false });
      await seed(repo, [makeStatement("statement-1"), makeStatement("statement-2", { usedDate: "2026-09-12", merchant: "表記の違う加盟店", amountYen: 900 }),
        makeStatement("statement-3", { usedDate: "2026-09-20", merchant: "記録のない店", amountYen: 3000 })], [], legacyAccountId);
      const run = await createLocalReconciliationService(repo, mock).run();
      results.push({ statements: run.statementResults, candidates: run.candidates });
    }

    expect(results[1]).toEqual(results[0]);
    expect(results[0]!.statements.map(row => row.status)).toEqual(["matched", "needs_review", "unmatched_statement"]);
  });

  it("reaches results with zero payment sources and asks for one only when registering an unrecorded statement", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.accounts.splice(0);
    await seed(repo, [makeStatement("statement-1", { merchant: "記録のない店" })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);

    const run = await service.run();

    expect(run.statementResults).toMatchObject([{ status: "unmatched_statement", reasonCodes: ["no_candidate"] }]);
    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-1", categoryId: "category-1" })).rejects.toMatchObject({ code: "account_unavailable" });
    expect(await service.resolutions()).toEqual([]);
  });

  it("requires a non-cash payment source chosen at registration time", async () => {
    const repo = await repository();
    const mock = makeLedger();
    await seed(repo, [makeStatement("statement-1", { merchant: "記録のない店" })]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();

    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "", categoryId: "category-1" })).rejects.toMatchObject({ code: "account_unavailable" });
    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-cash", categoryId: "category-1" })).rejects.toMatchObject({ code: "account_unavailable" });
    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-2", categoryId: "category-1" }))
      .resolves.toMatchObject({ status: "applied", accountId: "account-2" });
    expect(mock.transactions.get("actual-kakeimatch:statement:statement-1")).toMatchObject({ accountId: "account-2", cleared: true });
  });

  it("keeps the run valid when a payment source is added during registration", async () => {
    const repo = await repository();
    const mock = makeLedger();
    mock.accounts.splice(0);
    await seed(repo, [makeStatement("statement-1", { merchant: "記録のない店" })]);
    const service = new LocalReconciliationService(repo, mock.ledger as never);
    const run = await service.run();
    mock.accounts.push({ id: "account-new", name: "追加したカード", accountType: "credit_card", closed: false });

    await expect(service.noReceipt(run.runId, "statement-1", { accountId: "account-new", categoryId: "category-1" }))
      .resolves.toMatchObject({ status: "applied", accountId: "account-new" });
  });

  it("lists waiting records only for payment sources mapped to the statement provider", async () => {
    const repo = await repository();
    const mock = makeLedger();
    for (const accountId of ["account-1", "account-2", "account-cash"]) {
      mock.transactions.set(`waiting-${accountId}`, { id: `waiting-${accountId}`, date: "2026-09-15", amountYen: -5000,
        kind: "expense", payeeName: "未照合の店", categoryName: null, accountId, cleared: false });
    }
    await seed(repo, [makeStatement("statement-1")]);
    const service = new LocalReconciliationService(repo, mock.ledger as never, async accountId => accountId === "account-1" ? "paypay" : null);

    const run = await service.run();

    expect(run.receiptResults.map(row => [row.receiptId, row.status])).toEqual([["actual:waiting-account-1", "unmatched_receipt"]]);
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

describe("statement registration options", () => {
  it("keeps an ignored purchase resolved across reruns without writing a transaction", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("cancelled")]);
    const service = createLocalReconciliationService(repo, mock);
    const run = await service.run();
    await expect(service.ignore(run.runId, "cancelled")).resolves.toMatchObject({ resolution: "ignored", status: "applied", actualTransactionId: null });
    expect((await service.run()).statementResults).toEqual([]);
    expect(mock.transactions.size).toBe(0);
    await expect(service.ignore(run.runId, "cancelled")).rejects.toMatchObject({ code: "stale_run" });
  });
  it("can ignore a statement with candidates without clearing its existing expense", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("cancelled")]);
    mock.transactions.set("candidate", { id: "candidate", date: "2026-09-10", amountYen: -1150, kind: "expense", payeeName: "架空ストア新宿", categoryName: null, accountId: "account-1", cleared: false });
    const service = createLocalReconciliationService(repo, mock), run = await service.run();
    expect(run.candidates.length).toBeGreaterThan(0);
    await service.ignore(run.runId, "cancelled");
    expect(mock.transactions.get("candidate")?.cleared).toBe(false);
  });
  it("registers a linked transfer without category and retries without duplicates", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("charge")]);
    const service = createLocalReconciliationService(repo, mock), run = await service.run();
    mock.failUpdate();
    const failed = await service.noReceipt(run.runId, "charge", { accountId: "account-1", destinationAccountId: "account-2" });
    expect(failed).toMatchObject({ resolution: "transfer", status: "failed", categoryId: null });
    await expect(service.retry(failed.id)).resolves.toMatchObject({ status: "applied" });
    expect(mock.importedCount()).toBe(1);
    expect([...mock.transactions.values()][0]).toMatchObject({ kind: "transfer", transferAccountId: "account-2", amountYen: -1200, cleared: true });
  });
  it("rejects a transfer to its source account or a missing destination", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("charge")]);
    const service = createLocalReconciliationService(repo, mock), run = await service.run();
    for (const destinationAccountId of ["account-1", "missing"]) await expect(service.noReceipt(run.runId, "charge", { accountId: "account-1", destinationAccountId })).rejects.toMatchObject({ code: "destination_unavailable" });
    expect(mock.transactions.size).toBe(0);
  });
  it("preserves expense amount and records the exclusion preference", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("investment")]);
    const service = createLocalReconciliationService(repo, mock), run = await service.run();
    const saved = await service.noReceipt(run.runId, "investment", { accountId: "account-1", categoryId: "category-1", excludedFromSpending: true });
    expect(saved.status).toBe("applied");
    expect(mock.transactions.get(saved.actualTransactionId!)!).toMatchObject({ amountYen: -1200, excludedFromSpending: true });
  });
  it("fixes registration to the provider account regardless of supplied source", async () => {
    const repo = await repository(), mock = makeLedger();
    await seed(repo, [makeStatement("purchase")]);
    const service = new LocalReconciliationService(repo, mock.ledger as unknown as ConstructorParameters<typeof LocalReconciliationService>[1],
      async id => id === "account-2" ? "paypay" : null, async () => {});
    const run = await service.run();
    const saved = await service.noReceipt(run.runId, "purchase", { accountId: "account-1", categoryId: "category-1" });
    expect(saved).toMatchObject({ accountId: "account-2", status: "applied" });
  });
});
