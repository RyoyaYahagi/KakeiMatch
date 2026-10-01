import { describe, expect, it, vi } from "vitest";
import {
  ActualBudgetSelectionRequiredError,
  ActualBrowserUnavailableError,
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
    { id: "bank", name: "銀行", closed: false },
    { id: "closed", name: "旧口座", closed: true },
  ];
  const payees = [
    { id: "shop", name: "Synthetic Store" },
    { id: "transfer-to-cash", name: "Transfer: 現金", transfer_acct: "cash" },
    { id: "transfer-to-bank", name: "Transfer: 銀行", transfer_acct: "bank" },
  ];
  const rows: Array<Record<string, unknown>> = [
    { id: "expense", account: "cash", date: "2026-09-29", amount: -3284, payee: "shop", category: "food", cleared: false, imported_id: "receipt:1" },
    { id: "income", account: "cash", date: "2026-09-28", amount: 5000, payee: null, category: null, cleared: false },
    { id: "parent", account: "cash", date: "2026-09-27", amount: -1000, is_parent: true },
    { id: "split-a", parent_id: "parent", is_child: true, account: "cash", date: "2026-09-27", amount: -600, category: "food", cleared: false },
    { id: "split-b", parent_id: "parent", is_child: true, account: "cash", date: "2026-09-27", amount: -400, category: "home", cleared: false },
    { id: "transfer-out", account: "cash", date: "2026-09-26", amount: -700, transfer_id: "transfer-in" },
    { id: "transfer-in", account: "cash", date: "2026-09-26", amount: 700, transfer_id: "transfer-out" },
  ];
  const tombstoned = new Map<string, Record<string, unknown>>();
  const categories = [
      { id: "food", name: "食費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "home", name: "住居費", is_income: false, hidden: false, group_id: "expenses" },
      { id: "income-category", name: "給与", is_income: true, hidden: false, group_id: "income" },
    ];
  const api = {
    init: vi.fn(async ({ dataDir = "/documents" }: { dataDir?: string } = {}) => {
      activeDataDir = dataDir;
      if (!budgetsByDir.has(dataDir)) budgetsByDir.set(dataDir, []);
      const send = vi.fn(async (method: string, args?: { id?: string; updated?: Array<Record<string, unknown>>; added?: Array<Record<string, unknown>>; deleted?: Array<{ id: string }>; runTransfers?: boolean }) => {
        const localBudgets = budgetsByDir.get(activeDataDir)!;
        if (method === "get-budgets") return [...localBudgets];
        if (method === "close-budget") { activeBudget = null; return "ok"; }
        if (method === "delete-budget") {
          const index = localBudgets.findIndex((budget) => budget.id === args?.id);
          if (index >= 0) localBudgets.splice(index, 1);
          if (activeBudget === args?.id) activeBudget = null;
          return "ok";
        }
        if (method === "transactions-batch-update") {
          for (const deletion of args?.deleted ?? []) {
            const index = rows.findIndex(item => item.id === deletion.id);
            if (index >= 0) { tombstoned.set(deletion.id, rows[index]); rows.splice(index, 1); }
          }
          for (const update of args?.updated ?? []) {
            const row = rows.find(item => item.id === update.id);
            if (row) Object.assign(row, update);
            else if (update.tombstone === false && typeof update.id === "string" && tombstoned.has(update.id)) { rows.push({ ...tombstoned.get(update.id), ...update }); tombstoned.delete(update.id); }
          }
          rows.push(...(args?.added ?? []));
          return { updated: args?.updated ?? [], added: args?.added ?? [], deleted: args?.deleted ?? [], errors: [] };
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
    createPayee: vi.fn(async ({ name }: { name: string }) => { const id = `payee-${payees.length}`; payees.push({ id, name }); return id; }),
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
    addTransactions: vi.fn(async (accountId: string, imports: Array<Record<string, unknown>>, opts?: { runTransfers?: boolean }) => {
      for (const item of imports) {
        const id = `transfer-${rows.length}`;
        const destinationPayee = payees.find(payee => payee.id === item.payee) as { transfer_acct?: string } | undefined;
        const destination = destinationPayee?.transfer_acct;
        rows.push({ ...item, id, account: accountId });
        if (opts?.runTransfers && destination) {
          const peerId = `${id}-peer`;
          rows.push({ id: peerId, account: destination, date: item.date, amount: -Number(item.amount),
            payee: payees.find(payee => payee.transfer_acct === accountId)?.id, notes: item.notes, transfer_id: id });
          Object.assign(rows.find(row => row.id === id)!, { transfer_id: peerId });
        }
      }
      return "ok";
    }),
    updateTransaction: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const row = rows.find((item) => item.id === id);
      if (!row) throw new Error("not found");
      Object.assign(row, fields);
      if (row.transfer_id) {
        const peer = rows.find(item => item.id === row.transfer_id);
        if (peer) {
          const destinationPayee = payees.find(payee => payee.id === row.payee) as { transfer_acct?: string } | undefined;
          if (destinationPayee?.transfer_acct) peer.account = destinationPayee.transfer_acct;
          if (typeof fields.amount === "number") peer.amount = -Number(fields.amount);
          if ("notes" in fields) peer.notes = fields.notes;
          if (fields.account) peer.payee = payees.find(payee => payee.transfer_acct === fields.account)?.id;
        }
      }
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
  return { ledger: createActualBrowserLedger(options), api, rows, accounts, selectedBudget, saveBudgetId, sendHandlers, budgetsByDir, getActiveBudget: () => activeBudget };
}

describe("Actual browser ledger", () => {
  it("creates and remembers an empty local budget with runImport", async () => {
    const { ledger, api, selectedBudget, getActiveBudget } = fixture();
    await expect(ledger.listOpenAccounts()).resolves.toEqual([{ id: "cash", name: "現金" }, { id: "bank", name: "銀行" }]);
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
    expect(api.updateTransaction).toHaveBeenCalledWith("receipt-created", { category: "home", cleared: true });
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

  it("edits a receipt through awaited native updates and converts normal and split rows", async () => {
    const { ledger, api, rows, sendHandlers } = fixture([{ id: "budget", name: "Synthetic" }]);
    const receipt = rows.find(row => row.id === "expense")!;
    Object.assign(receipt, { imported_id: "kakeimatch:receipt:edit-1", notes: "keep this memo", cleared: true });
    const splitInput = {
      accountId: "bank", date: "2026-09-30", amountYen: -1000, merchant: "Synthetic Books",
      categoryId: "food", importedId: "kakeimatch:receipt:edit-1",
      splits: [{ categoryId: "food", amountYen: -600 }, { categoryId: "home", amountYen: -400 }],
    };
    await expect(ledger.editReceipt("expense", splitInput)).resolves.toMatchObject({
      id: "expense", amountYen: -1000, date: splitInput.date, accountId: "bank", isSplit: true, cleared: true,
    });
    expect(rows.filter(row => row.parent_id === "expense")).toHaveLength(2);
    expect(receipt).toMatchObject({ imported_id: splitInput.importedId, notes: "keep this memo", cleared: true, is_parent: true });
    const send = sendHandlers.at(-1)!;
    const firstUpdateCount = send.mock.calls.filter(([method]) => method === "transactions-batch-update").length;
    const repeated = await ledger.editReceipt("expense", splitInput);
    expect(repeated).toMatchObject({ id: "expense", amountYen: -1000, isSplit: true });
    expect(rows.filter(row => row.parent_id === "expense")).toHaveLength(2);
    expect(send.mock.calls.filter(([method]) => method === "transactions-batch-update")).toHaveLength(firstUpdateCount);

    const simpleInput = { ...splitInput, accountId: "cash", date: "2026-10-01", amountYen: -900, categoryId: "home", splits: undefined };
    await expect(ledger.editReceipt("expense", simpleInput)).resolves.toMatchObject({
      id: "expense", amountYen: -900, date: simpleInput.date, accountId: "cash", categoryId: "home", isSplit: false, cleared: true,
    });
    expect(rows.filter(row => row.parent_id === "expense")).toHaveLength(0);
    expect(receipt).toMatchObject({ imported_id: splitInput.importedId, notes: "keep this memo", cleared: true, is_parent: false });
    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(([method, args]) => method === "transactions-batch-update" && args?.runTransfers === false).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects receipt edits for other transaction kinds, mismatched imports, and invalid split totals", async () => {
    const { ledger, api, rows, sendHandlers } = fixture([{ id: "budget", name: "Synthetic" }]);
    const base = { accountId: "cash", date: "2026-09-29", amountYen: -1000, merchant: "Synthetic Store", categoryId: "food", importedId: "kakeimatch:receipt:expected" };
    await expect(ledger.editReceipt("expense", base)).rejects.toBeInstanceOf(ActualMasterValidationError);
    rows.find(row => row.id === "expense")!.imported_id = base.importedId;
    await expect(ledger.editReceipt("expense", { ...base, splits: [{ categoryId: "food", amountYen: -999 }] })).rejects.toThrow("Invalid Actual receipt transaction.");
    await expect(ledger.editReceipt("transfer-out", base)).rejects.toBeInstanceOf(ActualMasterValidationError);
    expect(sendHandlers.some(send => send.mock.calls.some(([method]) => method === "transactions-batch-update"))).toBe(false);
    expect(api.updateTransaction).not.toHaveBeenCalled();
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

  it("lists income categories and creates manual transactions idempotently with verified fields", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Synthetic" }]);
    await expect(ledger.listIncomeCategories()).resolves.toEqual([{ id: "income-category", name: "給与" }]);
    const input = {
      kind: "income" as const, amountYen: 65000, date: "2099-04-05", payeeName: "Synthetic Salary",
      categoryId: "income-category", accountId: "cash", memo: "monthly", importedId: "kakeimatch:manual:income-1",
    };
    await expect(ledger.createTransaction(input)).resolves.toMatchObject({
      kind: "income", amountYen: 65000, categoryId: "income-category", memo: "monthly",
      importedId: input.importedId, isSplit: false,
    });
    await expect(ledger.getTransactionById("receipt-created")).resolves.toMatchObject({ date: input.date, importedId: input.importedId });
    await expect(ledger.getRecentTransactions({ limit: 1 })).resolves.toEqual([expect.objectContaining({ date: input.date, importedId: input.importedId })]);
    expect(api.importTransactions).toHaveBeenCalledTimes(1);
    expect(api.importTransactions).toHaveBeenLastCalledWith("cash", [expect.objectContaining({
      amount: 65000, date: input.date, category: "income-category", notes: "monthly", imported_id: input.importedId,
    })]);
    await ledger.createTransaction(input);
    expect(api.importTransactions).toHaveBeenCalledTimes(1);
    rows.find(row => row.imported_id === input.importedId)!.amount = 64000;
    await expect(ledger.createTransaction(input)).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
    expect(api.importTransactions).toHaveBeenCalledTimes(1);
  });

  it("creates one native linked transfer pair and deduplicates by imported ID", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Local" }]);
    const input = { amountYen: 12500, date: "2026-09-30", sourceAccountId: "cash", destinationAccountId: "bank", memo: "移動", importedId: "kakeimatch:transfer:one" };
    const created = await ledger.createTransfer(input);
    expect(created).toMatchObject({ kind: "transfer", amountYen: -12500, accountId: "cash", transferAccountId: "bank", importedId: input.importedId });
    expect(created.transferId).toBeTruthy();
    const pair = rows.filter(row => row.imported_id === input.importedId || row.id === created.transferId);
    expect(pair).toHaveLength(2);
    expect(pair.map(row => row.transfer_id)).toEqual([created.transferId, created.id]);
    expect(api.addTransactions).toHaveBeenCalledWith("cash", [expect.objectContaining({ payee: "transfer-to-bank", amount: -12500 })], { runTransfers: true });
    await expect(ledger.createTransfer(input)).resolves.toMatchObject({ id: created.id, transferId: created.transferId });
    expect(api.addTransactions).toHaveBeenCalledOnce();
  });

  it("edits both sides of a transfer while keeping Actual's reciprocal link", async () => {
    const { ledger, rows, sendHandlers, api } = fixture([{ id: "budget", name: "Local" }]);
    const created = await ledger.createTransfer({ amountYen: 1000, date: "2026-09-29", sourceAccountId: "cash", destinationAccountId: "bank", memo: null, importedId: "transfer-edit" });
    const updated = await ledger.updateTransfer(created.id, { amountYen: 2400, date: "2026-09-30", sourceAccountId: "bank", destinationAccountId: "cash", memo: "修正" });
    expect(updated).toMatchObject({ kind: "transfer", amountYen: -2400, date: "2026-09-30", accountId: "bank", transferAccountId: "cash", importedId: "transfer-edit" });
    const source = rows.find(row => row.id === updated.id)!;
    const peer = rows.find(row => row.id === updated.transferId)!;
    expect(source).toMatchObject({ account: "bank", amount: -2400, date: "2026-09-30", notes: "修正", transfer_id: peer.id });
    expect(peer).toMatchObject({ account: "cash", amount: 2400, date: "2026-09-30", notes: "修正", transfer_id: source.id });
    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(sendHandlers.some(send => send.mock.calls.some(([method, args]) => method === "transactions-batch-update" &&
      args?.runTransfers === false && args.updated?.length === 2 && args.updated.every((update: Record<string, unknown>) => Boolean(update.transfer_id))))).toBe(true);
  });

  it("rejects same, closed, and unknown accounts for transfer creation", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    const base = { amountYen: 100, date: "2026-09-30", sourceAccountId: "cash", destinationAccountId: "bank", memo: null, importedId: "bad-transfer" };
    await expect(ledger.createTransfer({ ...base, destinationAccountId: "cash" })).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.createTransfer({ ...base, destinationAccountId: "closed" })).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.createTransfer({ ...base, destinationAccountId: "missing" })).rejects.toBeInstanceOf(ActualMasterValidationError);
    expect(api.addTransactions).not.toHaveBeenCalled();
  });

  it("updates ordinary manual transactions across dates, accounts, payees, categories and memo, preserving cleared", async () => {
    const { ledger, api, rows, accounts, sendHandlers } = fixture([{ id: "budget", name: "Synthetic" }]);
    accounts.push({ id: "bank", name: "銀行", closed: false });
    rows.find(row => row.id === "expense")!.cleared = true;
    const result = await ledger.updateTransaction("expense", {
      kind: "expense", amountYen: 2000, date: "2099-06-07", payeeName: "Synthetic Books",
      categoryId: "home", accountId: "bank", memo: "moved entry",
    });
    expect(result).toMatchObject({
      id: "expense", kind: "expense", amountYen: -2000, date: "2099-06-07", accountId: "bank",
      payeeName: "Synthetic Books", categoryId: "home", memo: "moved entry", cleared: true,
    });
    expect(api.createPayee).toHaveBeenCalledWith({ name: "Synthetic Books" });
    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(sendHandlers.some(send => send.mock.calls.some(([method, args]) => method === "transactions-batch-update" &&
      args?.updated?.some((update: Record<string, unknown>) => update.id === "expense" && update.account === "bank" && update.date === "2099-06-07" &&
        update.amount === -2000 && update.category === "home" && update.notes === "moved entry" && update.cleared === true && update.imported_id === "receipt:1")))).toBe(true);
  });

  it("rejects invalid manual categories and edits to receipt, transfer, and split rows before writes", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Synthetic" }]);
    await expect(ledger.createTransaction({
      kind: "expense", amountYen: 1, date: "2026-09-29", payeeName: "Synthetic", categoryId: "income-category",
      accountId: "cash", memo: null, importedId: "kakeimatch:manual:wrong-category",
    })).rejects.toBeInstanceOf(ActualMasterValidationError);
    rows.find(row => row.id === "expense")!.imported_id = "kakeimatch:receipt:receipt-1";
    await expect(ledger.updateTransaction("expense", {
      kind: "expense", amountYen: 100, date: "2026-09-29", payeeName: "Synthetic", categoryId: "food", accountId: "cash", memo: null,
    })).rejects.toBeInstanceOf(ActualMasterValidationError);
    rows.find(row => row.id === "expense")!.imported_id = undefined;
    for (const id of ["transfer-out", "parent", "split-a"]) {
      await expect(ledger.updateTransaction(id, {
        kind: "expense", amountYen: 100, date: "2026-09-29", payeeName: "Synthetic", categoryId: "food", accountId: "cash", memo: null,
      })).rejects.toBeInstanceOf(ActualMasterValidationError);
    }
    expect(api.importTransactions).not.toHaveBeenCalled();
    expect(api.updateTransaction).not.toHaveBeenCalled();
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

  it("deletes and restores complete scalar, split, and transfer groups with the same IDs", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Local" }]);
    for (const id of ["expense", "income", "parent"]) {
      const before = await ledger.getTransactionTree(id);
      expect(before.length).toBe(id === "parent" ? 3 : 1);
      await ledger.deleteTransactionTree(before);
      await expect(ledger.getTransactionTree(id)).resolves.toEqual([]);
      await ledger.deleteTransactionTree(before);
      await ledger.restoreTransactionTree(before);
      await ledger.restoreTransactionTree(before);
      expect(await ledger.getTransactionTree(id)).toEqual(before);
    }
    const transfer = await ledger.createTransfer({ date: "2026-09-30", amountYen: 100, sourceAccountId: "cash", destinationAccountId: "bank", memo: "Synthetic", importedId: "synthetic-delete-transfer" });
    const pair = await ledger.getTransactionTree(transfer.id);
    expect(pair).toHaveLength(2);
    await ledger.deleteTransactionTree(pair);
    expect(rows.some(row => pair.some(original => original.id === row.id))).toBe(false);
    await ledger.restoreTransactionTree(pair);
    expect(await ledger.getTransactionTree(transfer.id)).toEqual(pair);
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it("rejects stale deletions, partial groups and occupied IDs before native mutation", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Local" }]);
    const snapshot = await ledger.getTransactionTree("expense");
    rows.find(row => row.id === "expense")!.amount = -999;
    await expect(ledger.deleteTransactionTree(snapshot)).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.restoreTransactionTree(snapshot)).rejects.toBeInstanceOf(ActualMasterValidationError);
    const split = await ledger.getTransactionTree("parent");
    await expect(ledger.deleteTransactionTree(split.slice(0, 2))).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.getTransactionTree("split-a")).rejects.toBeInstanceOf(ActualMasterValidationError);
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
