import { describe, expect, it, vi } from "vitest";
import {
  ActualBudgetSelectionRequiredError,
  createActualBrowserLedger,
  type ActualBrowserLedgerOptions,
} from "@/lib/actual-browser-ledger";

function fixture(initialBudgets: Array<{ id: string; name: string }> = []) {
  const budgets = [...initialBudgets];
  let activeBudget: string | null = null;
  const accounts = [
    { id: "cash", name: "現金", closed: false },
    { id: "closed", name: "旧口座", closed: true },
  ];
  const payees = [{ id: "shop", name: "Synthetic Store" }];
  const rows: Array<Record<string, unknown>> = [
    { id: "expense", account: "cash", date: "2026-09-29", amount: -3284, payee: "shop", category: "food", cleared: false, imported_id: "receipt:1" },
    { id: "income", account: "cash", date: "2026-09-28", amount: 5000, payee: null, category: null, cleared: false },
    { id: "parent", account: "cash", date: "2026-09-27", amount: -1000, is_parent: true },
    { id: "split-a", account: "cash", date: "2026-09-27", amount: -600, category: "food", cleared: false },
    { id: "split-b", account: "cash", date: "2026-09-27", amount: -400, category: "home", cleared: false },
    { id: "transfer-out", account: "cash", date: "2026-09-26", amount: -700, transfer_id: "transfer-in" },
    { id: "transfer-in", account: "cash", date: "2026-09-26", amount: 700, transfer_id: "transfer-out" },
  ];
  const api = {
    init: vi.fn(async () => ({})),
    getBudgets: vi.fn(async () => [...budgets]),
    runImport: vi.fn(async (name: string, create: () => Promise<void>) => {
      await create();
      budgets.push({ id: "new-budget", name });
      activeBudget = "new-budget";
    }),
    loadBudget: vi.fn(async (id: string) => { activeBudget = id; }),
    getAccounts: vi.fn(async () => accounts),
    getCategories: vi.fn(async () => [
      { id: "food", name: "食費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "home", name: "住居費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "income-category", name: "給与", is_income: true, hidden: false, group_id: "income" },
    ]),
    getPayees: vi.fn(async () => [...payees]),
    getBudgetMonths: vi.fn(async () => ["2026-09"]),
    getTransactions: vi.fn(async (accountId: string, start: string, end: string) => rows.filter((row) => row.account === accountId && String(row.date) >= start && String(row.date) <= end)),
    importTransactions: vi.fn(async (accountId: string, imports: Array<Record<string, unknown>>) => {
      for (const item of imports) {
        if (rows.some((row) => row.imported_id === item.imported_id)) continue;
        const payeeId = "payee-" + item.imported_id;
        payees.push({ id: payeeId, name: String(item.payee_name) });
        rows.push({ id: "receipt-created", ...item, account: accountId, payee: payeeId, category: item.category });
      }
      return { added: [], updated: [], errors: [] };
    }),
    updateTransaction: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new Error("not found");
      Object.assign(row, fields);
      return [];
    }),
    createCategory: vi.fn(async () => "new-category"),
    updateCategory: vi.fn(async () => {}),
    batchBudgetUpdates: vi.fn(async (work: () => Promise<void>) => work()),
  };
  const selectedBudget = { current: initialBudgets.length === 1 ? initialBudgets[0]!.id : null };
  const options = {
    getBudgetId: () => selectedBudget.current,
    saveBudgetId: (id: string) => { selectedBudget.current = id; },
    api,
  } as unknown as ActualBrowserLedgerOptions;
  return { ledger: createActualBrowserLedger(options), api, rows, selectedBudget, getActiveBudget: () => activeBudget };
}

describe("Actual browser ledger", () => {
  it("creates and remembers an empty local budget with runImport", async () => {
    const { ledger, api, selectedBudget, getActiveBudget } = fixture();
    await expect(ledger.listOpenAccounts()).resolves.toEqual([{ id: "cash", name: "現金" }]);
    expect(api.init).toHaveBeenCalledWith({});
    expect(api.runImport).toHaveBeenCalledOnce();
    expect(selectedBudget.current).toBe("new-budget");
    expect(getActiveBudget()).toBe("new-budget");
  });

  it("requires local selection when multiple budgets exist", async () => {
    const { ledger, api } = fixture([{ id: "one", name: "A" }, { id: "two", name: "B" }]);
    await expect(ledger.listOpenAccounts()).rejects.toBeInstanceOf(ActualBudgetSelectionRequiredError);
    expect(api.loadBudget).not.toHaveBeenCalled();
  });

  it("preserves integer yen, split/transfer semantics, categories and stable receipt imports", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.getRecentTransactions({ limit: 20 })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "expense", amountYen: -3284, payeeName: "Synthetic Store", categoryName: "食費", kind: "expense" }),
      expect.objectContaining({ id: "income", amountYen: 5000, kind: "income" }),
      expect.objectContaining({ id: "transfer-out", kind: "transfer" }),
    ]));
    await expect(ledger.getTransactions({ startDate: "2026-09-29", endDate: "2026-09-29" }))
      .resolves.toEqual([expect.objectContaining({ id: "expense", amountYen: -3284 })]);
    const recent = await ledger.getRecentTransactions();
    expect(recent.some((row) => row.id === "parent")).toBe(false);
    await expect(ledger.getMonthlySpending({ yearMonth: "2026-09" })).resolves.toBe(4284);
    await expect(ledger.getTransactionById("expense")).resolves.toMatchObject({ amountYen: -3284 });
    await expect(ledger.listExpenseCategories()).resolves.toEqual([
      { id: "food", name: "食費" }, { id: "home", name: "住居費" },
    ]);
    await ledger.importReceipt({ accountId: "cash", date: "2026-09-29", amountYen: -1200, merchant: "Synthetic Cafe", categoryId: "food", importedId: "receipt:2" });
    await ledger.importReceipt({ accountId: "cash", date: "2026-09-29", amountYen: -1200, merchant: "Synthetic Cafe", categoryId: "food", importedId: "receipt:2" });
    expect(api.importTransactions).toHaveBeenCalledTimes(2);
    expect(api.importTransactions.mock.calls[0]?.[1][0]).toMatchObject({ account: "cash", amount: -1200, imported_id: "receipt:2" });
    await ledger.updateReceipt("receipt-created", { categoryId: "home", cleared: true });
    await ledger.applyTransactionUpdates([{ transactionId: "expense", amountYen: -3280, cleared: true }]);
    expect(api.batchBudgetUpdates).toHaveBeenCalledTimes(2);
    expect(api.updateTransaction).toHaveBeenCalledWith("expense", { amount: -3280, cleared: true });
  });
  it("accepts Actual's case formatting but rejects a different payee on read-back", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Synthetic" }]);
    api.getPayees.mockResolvedValue([{ id: "payee-receipt:case", name: "Synthetic Cafe" }]);
    const input = { accountId: "cash", date: "2026-09-29", amountYen: -1200, merchant: "synthetic cafe", categoryId: "food", importedId: "receipt:case" };
    await expect(ledger.importReceipt(input)).resolves.toMatchObject({ payeeName: "Synthetic Cafe" });
    api.getPayees.mockResolvedValue([{ id: "payee-receipt:case", name: "Different Store" }]);
    await expect(ledger.importReceipt(input)).rejects.toMatchObject({ reason: "invalid_data" });
  });

});
