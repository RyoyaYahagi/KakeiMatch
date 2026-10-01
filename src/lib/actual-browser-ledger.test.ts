import { describe, expect, it, vi } from "vitest";
import {
  ActualBudgetSelectionRequiredError,
  ActualMasterValidationError,
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
    { id: "split-a", parent_id: "parent", is_child: true, account: "cash", date: "2026-09-27", amount: -600, category: "food", cleared: false },
    { id: "split-b", parent_id: "parent", is_child: true, account: "cash", date: "2026-09-27", amount: -400, category: "home", cleared: false },
    { id: "transfer-out", account: "cash", date: "2026-09-26", amount: -700, transfer_id: "transfer-in" },
    { id: "transfer-in", account: "cash", date: "2026-09-26", amount: 700, transfer_id: "transfer-out" },
  ];
  const categories = [
      { id: "food", name: "食費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "home", name: "住居費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "income-category", name: "給与", is_income: true, hidden: false, group_id: "income" },
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
    getCategories: vi.fn(async () => categories),
    getCategoryGroups: vi.fn(async () => [{ id: "expenses", name: "支出", is_income: false, hidden: false }, { id: "income", name: "収入", is_income: true, hidden: false }]),
    createCategoryGroup: vi.fn(async () => "new-group"),
    getPayees: vi.fn(async () => [...payees]),
    getBudgetMonths: vi.fn(async () => ["2026-09"]),
    getTransactions: vi.fn(async (accountId: string, start: string, end: string) => rows.filter((row) => row.account === accountId && String(row.date) >= start && String(row.date) <= end)),
    importTransactions: vi.fn(async (accountId: string, imports: Array<Record<string, unknown>>) => {
      for (const item of imports) {
        if (rows.some((row) => row.imported_id === item.imported_id)) continue;
        const payeeId = "payee-" + item.imported_id;
        payees.push({ id: payeeId, name: String(item.payee_name) });
        const subtransactions = item.subtransactions as Array<{ amount: number; category: string }> | undefined;
        const id = "receipt-created";
        const parentFields = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "subtransactions"));
        rows.push({ id, ...parentFields, ...(subtransactions ? { is_parent: true } : {}), account: accountId, payee: payeeId, category: item.category });
        subtransactions?.forEach((split, index) => rows.push({ id: `${id}/child-${index}`, parent_id: id, is_child: true, account: accountId, date: String(item.date), amount: split.amount, category: split.category }));
      }
      return { added: [], updated: [], errors: [] };
    }),
    updateTransaction: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new Error("not found");
      Object.assign(row, fields);
      return [];
    }),
    createCategory: vi.fn(async (input: { name: string; group_id: string; is_income: boolean; hidden: boolean }) => { const id = categories.some(c => c.id === "new-category") ? "new-category-2" : "new-category"; categories.push({ id, ...input }); return id; }),
    updateCategory: vi.fn(async (id: string, changes: Record<string, unknown>) => { Object.assign(categories.find(c => c.id === id)!, changes); }),
    deleteCategory: vi.fn(async (id: string) => { categories.splice(categories.findIndex(c => c.id === id), 1); }),
    createAccount: vi.fn(async (input: { name: string; closed: boolean }) => { accounts.push({ id: "new-account", ...input }); return "new-account"; }),
    updateAccount: vi.fn(async (id: string, changes: Record<string, unknown>) => { Object.assign(accounts.find(a => a.id === id)!, changes); }),
    getAccountBalance: vi.fn(async () => 0),
    closeAccount: vi.fn(async (id: string) => { accounts.find(a => a.id === id)!.closed = true; }),
    reopenAccount: vi.fn(async (id: string) => { accounts.find(a => a.id === id)!.closed = false; }),
    deleteAccount: vi.fn(async (id: string) => { accounts.splice(accounts.findIndex(a => a.id === id), 1); }),
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

  it("preserves incomplete-import classification when returning to the source directory also fails", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Existing" }]);
    const reactivationError = new Error("source init failed");
    api.importBudget.mockRejectedValueOnce(new Error("partial import"));
    const init = api.init.getMockImplementation()!;
    api.init.mockImplementation(async (options) => {
      if (options?.dataDir === "/documents") throw reactivationError;
      return init(options);
    });
    const error = await ledger.restoreBackup(new Uint8Array([8]), "/failed/profile").catch(error => error);
    expect(error).toBeInstanceOf(ActualRestoreIncompleteError);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors).toContain(reactivationError);
  });

  it("preserves occupied-target classification when returning to the source directory also fails", async () => {
    const { ledger, api, budgetsByDir, sendHandlers } = fixture([{ id: "budget", name: "Existing" }]);
    budgetsByDir.set("/occupied/profile", [{ id: "other", name: "Other" }]);
    const init = api.init.getMockImplementation()!;
    api.init.mockImplementation(async (options) => {
      if (options?.dataDir === "/documents") throw new Error("source init failed");
      return init(options);
    });
    await expect(ledger.restoreBackup(new Uint8Array([8]), "/occupied/profile"))
      .rejects.toBeInstanceOf(ActualRestoreTargetExistsError);
    expect(api.importBudget).not.toHaveBeenCalled();
    expect(sendHandlers.some(send => send.mock.calls.some(([method]) => method === "delete-budget"))).toBe(false);
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
    expect(recent.some((row) => row.id === "parent" && row.amountYen === -1000)).toBe(true);
    expect(recent.some((row) => row.id === "split-a" || row.id === "split-b")).toBe(false);
    await expect(ledger.getTransactionById("parent")).resolves.toMatchObject({ id: "parent", amountYen: -1000 });
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

  it("imports and verifies split receipt children atomically, and validates existing imports on retry", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Synthetic" }]);
    const input = {
      accountId: "cash", date: "2026-09-29", amountYen: -1000, merchant: "Synthetic Market",
      categoryId: "food", importedId: "receipt:split",
      splits: [{ categoryId: "food", amountYen: -600 }, { categoryId: "home", amountYen: -400 }],
    };
    await expect(ledger.importReceipt(input)).resolves.toMatchObject({ id: "receipt-created", amountYen: -1000, kind: "expense" });
    expect(api.importTransactions).toHaveBeenCalledTimes(1);
    expect(api.importTransactions.mock.calls[0]?.[1][0]).toMatchObject({
      imported_id: "receipt:split",
      subtransactions: [{ amount: -600, category: "food" }, { amount: -400, category: "home" }],
    });
    await expect(ledger.getTransactions({ startDate: input.date, endDate: input.date }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "receipt-created", amountYen: -1000 })]));

    rows.find(row => row.parent_id === "receipt-created" && row.category === "home")!.amount = -399;
    await expect(ledger.importReceipt(input)).rejects.toMatchObject({ reason: "invalid_data" });
    expect(api.importTransactions).toHaveBeenCalledTimes(2);
  });

  it("preserves split totals during reconciliation while allowing equal amount confirmation", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Synthetic" }]);
    await expect(ledger.applyTransactionUpdates([{ transactionId: "parent", amountYen: -900, cleared: true }]))
      .rejects.toBeInstanceOf(ActualMasterValidationError);
    expect(api.updateTransaction).not.toHaveBeenCalled();
    await ledger.applyTransactionUpdates([{ transactionId: "parent", amountYen: -1000, cleared: true }]);
    expect(api.updateTransaction).toHaveBeenCalledWith("parent", { amount: -1000, cleared: true });
  });

  it("rejects invalid split totals, positive amounts, and unavailable split categories before import", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Synthetic" }]);
    const base = { accountId: "cash", date: "2026-09-29", amountYen: -1000, merchant: "Synthetic Market", categoryId: "food", importedId: "receipt:invalid" };
    await expect(ledger.importReceipt({ ...base, splits: [{ categoryId: "food", amountYen: -999 }] })).rejects.toThrow("Invalid Actual receipt transaction.");
    await expect(ledger.importReceipt({ ...base, splits: [{ categoryId: "food", amountYen: 0 }, { categoryId: "home", amountYen: -1000 }] })).rejects.toThrow("Invalid Actual receipt transaction.");
    await expect(ledger.importReceipt({ ...base, splits: [{ categoryId: "income-category", amountYen: -1000 }] })).rejects.toBeInstanceOf(ActualMasterValidationError);
    expect(api.importTransactions).not.toHaveBeenCalled();
  });

  it("separates income categories and keeps custom and hidden categories manageable", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    await ledger.addCategory("  特別手当  ", true);
    expect(api.createCategory).toHaveBeenLastCalledWith({ name: "特別手当", group_id: "income", is_income: true, hidden: false });
    expect((await ledger.listExpenseCategories()).some(c => c.name === "特別手当")).toBe(false);
    const expenseId = await ledger.addCategory("趣味", false);
    await ledger.renameCategory(expenseId, "余暇");
    await ledger.setCategoryHidden(expenseId, true);
    expect(await ledger.listCategories()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "余暇", hidden: true })]));
    expect((await ledger.listExpenseCategories()).some(c => c.name === "余暇")).toBe(false);
    await ledger.setCategoryHidden(expenseId, false);
    expect((await ledger.listExpenseCategories()).some(c => c.name === "余暇")).toBe(true);
  });

  it("refuses to delete categories used by split children, closed accounts or future transactions", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Local" }]);
    rows.push({ id: "future", account: "closed", date: "2099-01-01", amount: -10, category: "income-category" });
    expect(await ledger.getCategoryUsage("home")).toBe(1);
    await expect(ledger.deleteCategory("home")).rejects.toThrow("既存の取引");
    await expect(ledger.deleteCategory("income-category")).rejects.toThrow("既存の取引");
    expect(api.deleteCategory).not.toHaveBeenCalled();
    await ledger.addCategory("未使用", false);
    await ledger.deleteCategory("new-category");
    expect(api.deleteCategory).toHaveBeenCalledWith("new-category");
    expect(rows.some(row => row.id === "split-b")).toBe(true);
  });

  it("keeps history when closing and reopening an account and only deletes empty zero-balance accounts", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Local" }]);
    const initialIds = rows.map(r => r.id);
    expect((await ledger.listAccounts()).find(a => a.id === "closed")?.closed).toBe(true);
    await ledger.renameAccount("cash", "手持ち現金");
    await expect(ledger.deleteAccount("cash")).rejects.toThrow("完全削除できません");
    expect(api.deleteAccount).not.toHaveBeenCalled();
    api.getAccountBalance.mockResolvedValueOnce(100);
    await expect(ledger.closeAccount("cash")).rejects.toThrow("残高");
    await ledger.closeAccount("cash");
    expect((await ledger.listOpenAccounts()).some(a => a.id === "cash")).toBe(false);
    await ledger.reopenAccount("cash");
    expect((await ledger.listOpenAccounts()).some(a => a.name === "手持ち現金")).toBe(true);
    await ledger.addAccount("空の口座");
    await ledger.closeAccount("new-account");
    expect(api.updateAccount).toHaveBeenCalledWith("new-account", { closed: true });
    expect((await ledger.listAccounts()).find(a => a.id === "new-account")?.closed).toBe(true);
    await ledger.reopenAccount("new-account");
    api.getAccountBalance.mockResolvedValueOnce(1);
    await expect(ledger.deleteAccount("new-account")).rejects.toThrow("完全削除できません");
    await ledger.deleteAccount("new-account");
    expect(api.deleteAccount).toHaveBeenCalledWith("new-account");
    expect(rows.map(r => r.id)).toEqual(initialIds);
  });

  it("rejects blank names and missing or hidden receipt masters at the adapter boundary", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    expect(() => ledger.addAccount("   ")).toThrow("名前");
    expect(() => ledger.addCategory("", false)).toThrow("名前");
    await expect(ledger.renameAccount("missing", "新名称")).rejects.toThrow("見つかりません");
    await ledger.setCategoryHidden("food", true);
    await expect(ledger.importReceipt({ accountId: "cash", date: "2026-09-29", amountYen: -100, merchant: "人工店舗", categoryId: "food", importedId: "receipt:hidden" })).rejects.toThrow("支出カテゴリ");
    await expect(ledger.importReceipt({ accountId: "closed", date: "2026-09-29", amountYen: -100, merchant: "人工店舗", categoryId: "home", importedId: "receipt:closed" })).rejects.toThrow("支払元");
    expect(api.importTransactions).not.toHaveBeenCalled();
  });

});

it("handles Actual's grouped split response with nullable parent IDs and counts children once", async () => {
  const { ledger, api } = fixture([{ id: 'budget', name: 'Synthetic' }]);
  const children = [{ id: 'child-a', amount: -600, category: 'food' }, { id: 'child-b', amount: -400, category: 'home' }];
  api.getTransactions.mockImplementation(async (accountId: string) => accountId === 'cash' ? [{ id: 'grouped-parent', account: 'cash', date: '2026-09-27', amount: -1000, payee: 'shop', category: null, parent_id: null, is_parent: true, is_child: false, subtransactions: children }] : []);
  expect(await ledger.getMonthlySpending({ yearMonth: '2026-09' })).toBe(1000);
  expect(await ledger.getTransactions({ startDate: '2026-09-01', endDate: '2026-09-30' })).toEqual([expect.objectContaining({ id: 'grouped-parent', amountYen: -1000 })]);
  expect(await ledger.getTransactionById('grouped-parent')).toMatchObject({ amountYen: -1000 });
});
