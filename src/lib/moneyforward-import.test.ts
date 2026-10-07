import { describe, expect, it } from "vitest";
import { MoneyForwardImportService } from "../../apps/pwa/src/moneyforward-import";
import type { MoneyForwardRow } from "../../apps/pwa/src/moneyforward-parser";
import type { NativeTransactionSnapshot } from "./actual-browser-ledger";
import type { ActualTransaction } from "./actual-ledger";
import type { LocalDataRecord } from "./local-data";

function row(patch: Partial<MoneyForwardRow> = {}): MoneyForwardRow {
  return {
    rowNumber: 2, date: "2026-09-21", description: "Synthetic Store", amountYen: -1200, kind: "expense",
    accountName: "カードA", majorCategory: "食費", minorCategory: "食料品", memo: "", sourceTransactionId: "mf-1",
    sourceKey: "a".repeat(64), isTransfer: false, isIncludedInCalculation: true, categoryNeedsReviewReason: null,
    ...patch,
  };
}

function fixture() {
  const records = new Map<string, LocalDataRecord>();
  const repository = {
    get: async <T,>(id: string) => (records.get(id) as LocalDataRecord<T> | undefined) ?? null,
    put: async (record: LocalDataRecord) => { records.set(record.id, structuredClone(record)); },
  };
  const accounts = [{ id: "acct-existing", name: "カードA", closed: false }];
  const categories = [{ id: "food", name: "食費", isIncome: false }];
  const transactions = new Map<string, { transaction: ActualTransaction; snapshot: NativeTransactionSnapshot[] }>();
  let nextId = 0;
  let failNextAfterWrite = false;
  const ledger = {
    listAccounts: async () => accounts,
    listCategories: async () => categories,
    addAccount: async (name: string) => { const account = { id: `acct-${accounts.length + 1}`, name, closed: false }; accounts.push(account); return account.id; },
    addCategory: async (name: string, isIncome: boolean) => { const category = { id: `cat-${categories.length + 1}`, name, isIncome }; categories.push(category); return category.id; },
    listImportedIds: async () => new Set(transactions.keys()),
    getImportedTransaction: async (id: string) => transactions.get(id) ? structuredClone(transactions.get(id)!) : null,
    importExternalTransaction: async (input: { accountId: string; date: string; amountYen: number; kind: "expense" | "income"; importedId: string; categoryId: string | null }) => {
      const existing = transactions.get(input.importedId);
      if (existing) return { ...structuredClone(existing), alreadyExisted: true };
      const id = `txn-${++nextId}`;
      const amountYen = input.kind === "expense" ? -input.amountYen : input.amountYen;
      const snapshot: NativeTransactionSnapshot[] = [{ id, account: input.accountId, date: input.date, amount: amountYen, category: input.categoryId, imported_id: input.importedId }];
      const transaction = { id, date: input.date, amountYen, kind: input.kind, accountId: input.accountId,
        importedId: input.importedId, categoryId: input.categoryId, memo: "",
        payeeName: "Synthetic Store", categoryName: input.categoryId ? "食費" : null, cleared: false };
      transactions.set(input.importedId, { transaction, snapshot });
      if (failNextAfterWrite) { failNextAfterWrite = false; throw new Error("simulated interrupted journal write"); }
      return { transaction, snapshot, alreadyExisted: false };
    },
    getTransactionTree: async (id: string) => {
      const match = [...transactions.values()].find(value => value.snapshot[0]?.id === id);
      return match ? structuredClone(match.snapshot) : [];
    },
    deleteTransactionTree: async (snapshot: NativeTransactionSnapshot[]) => {
      const match = [...transactions.entries()].find(([, value]) => value.snapshot[0]?.id === snapshot[0]?.id);
      if (match) transactions.delete(match[0]);
    },
  };
  const idSequence = { value: 0 };
  const service = new MoneyForwardImportService(repository, ledger, {
    getBudgetId: () => "budget-1",
    withLock: async (_name, work) => work(),
    makeId: () => `batch-${++idSequence.value}`,
  });
  return { service, records, accounts, categories, transactions, interruptAfterWrite: () => { failNextAfterWrite = true; } };
}

describe("MoneyForwardImportService", () => {
  it("counts repeated stable IDs in one file as duplicates", async () => {
    const { service, transactions } = fixture();
    const repeated = row({ sourceTransactionId: null, sourceKey: "f".repeat(64) });
    const plan = await service.plan([repeated, { ...repeated, rowNumber: 3 }], {
      categories: { [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "existing", categoryId: "food" } },
      accounts: { "カードA": { kind: "existing", accountId: "acct-existing" } },
    });
    expect(plan.summary).toMatchObject({ ready: 1, duplicates: 1 });
    const result = await service.confirm(plan.batchId);
    expect(result.rows.map(item => item.status)).toEqual(["created", "duplicate"]);
    expect(transactions.size).toBe(1);
  });

  it("rechecks cross-account duplicates at confirmation and undo preserves transactions outside the batch", async () => {
    const { service, transactions, accounts } = fixture();
    const first = row();
    transactions.set(`moneyforward:${first.sourceKey}`, {
      transaction: { id: "old", date: "2026-09-21", amountYen: -1200, kind: "expense", accountId: "another-account", importedId: `moneyforward:${first.sourceKey}`, payeeName: "Synthetic Store", categoryName: "食費", categoryId: "food", cleared: false },
      snapshot: [{ id: "old", account: "another-account", date: "2026-09-21", amount: -1200, imported_id: `moneyforward:${first.sourceKey}` }],
    });
    const second = row({ rowNumber: 3, sourceTransactionId: "mf-2", sourceKey: "b".repeat(64), description: "Another shop" });
    const plan = await service.plan([first, second], {
      categories: { [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "existing", categoryId: "food" } },
      accounts: { "カードA": { kind: "existing", accountId: "acct-existing" } },
    });
    expect(plan.summary.duplicates).toBe(1);
    // A different importer creates the second row after preview. Confirmation catches it.
    transactions.set(plan.previewRows[1]!.importedId, {
      transaction: { id: "raced", date: second.date, amountYen: -1200, kind: "expense", accountId: "acct-existing", importedId: plan.previewRows[1]!.importedId, payeeName: "Synthetic Store", categoryName: "食費", cleared: false },
      snapshot: [{ id: "raced", account: "acct-existing", date: second.date, amount: -1200, imported_id: plan.previewRows[1]!.importedId }],
    });
    const completed = await service.confirm(plan.batchId);
    expect(completed.rows.map(item => item.status)).toEqual(["duplicate", "duplicate"]);
    await service.undo(plan.batchId);
    expect(transactions.has(`moneyforward:${first.sourceKey}`)).toBe(true);
    expect(transactions.has(plan.previewRows[1]!.importedId)).toBe(true);
    expect(accounts).toHaveLength(1);
  });

  it("imports unclassified rows into the unset source account and undoes only its own transaction", async () => {
    const { service, transactions, accounts } = fixture();
    const unclassified = row({ sourceTransactionId: null, sourceKey: "c".repeat(64) });
    const plan = await service.plan([unclassified], {
      categories: { [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "unclassified" } },
    });
    const completed = await service.confirm(plan.batchId);
    expect(completed.status).toBe("completed");
    const imported = [...transactions.values()][0]!;
    expect(imported.snapshot[0]?.category).toBeNull();
    expect(accounts[1]?.name).toBe("移行元未設定");
    const undone = await service.undo(plan.batchId);
    expect(undone.status).toBe("undone");
    expect(transactions.size).toBe(0);
    // Undo removes imported transactions only; newly made masters stay available.
    expect(accounts).toHaveLength(2);
  });

  it("recovers an Actual write whose result was not journaled before retry or undo", async () => {
    const { service, transactions, interruptAfterWrite } = fixture();
    const source = row({ sourceTransactionId: "interrupted", sourceKey: "d".repeat(64) });
    const plan = await service.plan([source], {
      categories: { [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "existing", categoryId: "food" } },
      accounts: { "カードA": { kind: "existing", accountId: "acct-existing" } },
    });
    interruptAfterWrite();
    const partial = await service.confirm(plan.batchId);
    expect(partial.rows[0]?.status).toBe("importing");
    const recovered = await service.confirm(plan.batchId);
    expect(recovered.rows[0]?.status).toBe("created");
    expect(transactions.size).toBe(1);
    await service.undo(plan.batchId);
    expect(transactions.size).toBe(0);
  });

  it("undo removes a later edit using the same original transaction identity", async () => {
    const { service, transactions } = fixture();
    const plan = await service.plan([row()], {
      categories: { [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "unclassified" } },
      accounts: { "カードA": { kind: "existing", accountId: "acct-existing" } },
    });
    await service.confirm(plan.batchId);
    const saved = transactions.get(plan.previewRows[0]!.importedId)!;
    saved.snapshot[0]!.amount = -1800;
    saved.transaction.amountYen = -1800;
    expect((await service.undo(plan.batchId)).status).toBe("undone");
    expect(transactions.size).toBe(0);
  });

  it("reports failures per row and retries only the failed row", async () => {
    const { service, categories, transactions } = fixture();
    const rows = [row(), row({ rowNumber: 3, sourceTransactionId: "income-1", sourceKey: "e".repeat(64), kind: "income", amountYen: 9000, majorCategory: "給与", minorCategory: "給与" })];
    const plan = await service.plan(rows, {
      categories: {
        [JSON.stringify(["expense", "食費", "食料品"])]: { kind: "existing", categoryId: "food" },
        [JSON.stringify(["income", "給与", "給与"])]: { kind: "existing", categoryId: "food" },
      },
      accounts: { "カードA": { kind: "existing", accountId: "acct-existing" } },
    });
    const first = await service.confirm(plan.batchId);
    expect(first.status).toBe("partial");
    expect(first.rows.map(item => item.status)).toEqual(["created", "failed"]);
    categories.push({ id: "salary", name: "給与", isIncome: true });
    await service.updateMappings(plan.batchId, {
      categories: { [JSON.stringify(["income", "給与", "給与"])]: { kind: "existing", categoryId: "salary" } },
    });
    const second = await service.confirm(plan.batchId);
    expect(second.status).toBe("completed");
    expect(second.rows.map(item => item.status)).toEqual(["created", "created"]);
    expect(transactions.size).toBe(2);
    expect([...transactions.values()].find(value => value.transaction.kind === "income")?.snapshot[0]?.amount).toBe(9000);
  });
});
