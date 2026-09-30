import { describe, expect, it, vi } from "vitest";
import {
  ActualBudgetSelectionRequiredError,
  ActualRestoreIncompleteError,
  ActualRestoreTargetExistsError,
  createActualBrowserLedger,
  type ActualBrowserLedgerOptions,
} from "@/lib/actual-browser-ledger";

function fixture(initialBudgets: Array<{ id: string; name: string }> = []) {
  const budgets = [...initialBudgets];
  const budgetsByDir = new Map<string, Array<{ id: string; name: string }>>([["/documents", budgets]]);
  const sendHandlers: Array<ReturnType<typeof vi.fn>> = [];
  let activeDataDir = "/documents";
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
    init: vi.fn(async ({ dataDir = "/documents" }: { dataDir?: string } = {}) => {
      activeDataDir = dataDir;
      if (!budgetsByDir.has(dataDir)) budgetsByDir.set(dataDir, []);
      const send = vi.fn(async (method: string, args?: { id?: string }) => {
        const localBudgets = budgetsByDir.get(activeDataDir)!;
        if (method === "get-budgets") return [...localBudgets];
        if (method === "close-budget") { activeBudget = null; return "ok"; }
        if (method === "delete-budget") {
          const index = localBudgets.findIndex((budget) => budget.id === args?.id);
          if (index >= 0) localBudgets.splice(index, 1);
          if (activeBudget === args?.id) activeBudget = null;
          return "ok";
        }
        throw new Error(`Unexpected Actual handler: ${method}`);
      });
      sendHandlers.push(send);
      return { send };
    }),
    shutdown: vi.fn(async () => { activeBudget = null; }),
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
    exportBudget: vi.fn(async () => new Uint8Array([1, 2, 3])),
    importBudget: vi.fn(async () => {
      const localBudgets = budgetsByDir.get(activeDataDir)!;
      localBudgets.push({ id: "restored-budget", name: "Restored" });
      activeBudget = "restored-budget";
      return { id: "restored-budget" };
    }),
  };
  const selectedBudget = { current: initialBudgets.length === 1 ? initialBudgets[0]!.id : null };
  const saveBudgetId = vi.fn((id: string) => { selectedBudget.current = id; });
  const options = {
    getBudgetId: () => selectedBudget.current,
    saveBudgetId,
    api,
  } as unknown as ActualBrowserLedgerOptions;
  return { ledger: createActualBrowserLedger(options), api, rows, selectedBudget, saveBudgetId, sendHandlers, budgetsByDir, getActiveBudget: () => activeBudget };
}

describe("Actual browser ledger", () => {
  it("creates and remembers an empty local budget with runImport", async () => {
    const { ledger, api, selectedBudget, getActiveBudget } = fixture();
    await expect(ledger.listOpenAccounts()).resolves.toEqual([{ id: "cash", name: "現金" }]);
    expect(api.init).toHaveBeenCalledWith({ dataDir: "/documents" });
    expect(api.runImport).toHaveBeenCalledOnce();
    expect(selectedBudget.current).toBe("new-budget");
    expect(getActiveBudget()).toBe("new-budget");
  });

  it("exports a backup from the selected budget", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.exportBackup()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(api.loadBudget).toHaveBeenCalledWith("budget");
    expect(api.exportBudget).toHaveBeenCalledOnce();
  });

  it("restores into a new empty data directory without changing the selected budget", async () => {
    const { ledger, api, selectedBudget, saveBudgetId } = fixture([{ id: "budget", name: "Existing" }]);
    await expect(ledger.restoreBackup(new Uint8Array([4, 5]), "/restored/profile-1"))
      .resolves.toBe("restored-budget");
    expect(api.importBudget).toHaveBeenCalledWith(new Uint8Array([4, 5]), {
      type: "actual", filename: "kakeimatch-backup.zip",
    });
    expect(selectedBudget.current).toBe("budget");
    expect(saveBudgetId).not.toHaveBeenCalled();
    expect(api.shutdown).toHaveBeenCalled();
    expect(api.init).toHaveBeenLastCalledWith({ dataDir: "/documents" });
  });

  it("removes budgets imported into the restore directory when validation fails", async () => {
    const { ledger, api, sendHandlers, budgetsByDir } = fixture([{ id: "budget", name: "Existing" }]);
    api.importBudget.mockImplementationOnce(async () => {
      budgetsByDir.get("/failed/profile")!.push({ id: "partial-budget", name: "Partial" });
      throw new Error("invalid archive");
    });
    await expect(ledger.restoreBackup(new Uint8Array([8]), "/failed/profile"))
      .rejects.toBeInstanceOf(ActualRestoreIncompleteError);
    expect(sendHandlers.some((send) => send.mock.calls.some(([method, args]) => method === "delete-budget" && args?.id === "partial-budget"))).toBe(true);
  });

  it("does not touch a non-empty restore directory", async () => {
    const { ledger, sendHandlers } = fixture([{ id: "budget", name: "Existing" }]);
    await expect(ledger.restoreBackup(new Uint8Array([9]), "/documents"))
      .rejects.toBeInstanceOf(ActualRestoreTargetExistsError);
    expect(sendHandlers.some((send) => send.mock.calls.some(([method]) => method === "delete-budget"))).toBe(false);
  });

  it("lists and deletes local budgets through Actual's typed handlers", async () => {
    const { ledger, sendHandlers } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.listLocalBudgets()).resolves.toEqual([{ id: "budget", name: "Local" }]);
    await ledger.deleteLocalBudget("budget");
    expect(sendHandlers.some((send) => send.mock.calls.some(([method, args]) =>
      method === "delete-budget" && JSON.stringify(args) === JSON.stringify({ id: "budget" })))).toBe(true);
    await expect(ledger.listLocalBudgets()).resolves.toEqual([]);
  });

  it("discards every budget in a dedicated restore directory", async () => {
    const { ledger, api, budgetsByDir, sendHandlers } = fixture([{ id: "budget", name: "Local" }]);
    budgetsByDir.set("/restore/profile", [{ id: "restored", name: "Restored" }]);
    await ledger.discardDataDirectory("/restore/profile");
    expect(budgetsByDir.get("/restore/profile")).toEqual([]);
    expect(sendHandlers.some((send) => send.mock.calls.some(([method, args]) =>
      method === "delete-budget" && args?.id === "restored"))).toBe(true);
    expect(api.init).toHaveBeenLastCalledWith({ dataDir: "/documents" });
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
