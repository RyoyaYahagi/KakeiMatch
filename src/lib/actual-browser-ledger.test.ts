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

function fixture(initialBudgets: Array<{ id: string; name: string }> = [], accountMetadata: Pick<ActualBrowserLedgerOptions, "getAccountType" | "saveAccountType"> = {}) {
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
      { id: "hidden", name: "旧カテゴリ", is_income: false, hidden: true, group_id: "expenses" },
      { id: "income-category", name: "給与", is_income: true, hidden: false, group_id: "income" },
    ];
  const budgetValues = new Map<string, number>([["food", 10000], ["home", 5000], ["hidden", -200]]);
  const schedules: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  const api = {
    init: vi.fn(async ({ dataDir = "/documents" }: { dataDir?: string } = {}) => {
      activeDataDir = dataDir;
      if (!budgetsByDir.has(dataDir)) budgetsByDir.set(dataDir, []);
      const send = vi.fn(async (method: string, args?: { id?: string; updated?: Array<Record<string, unknown>>; added?: Array<Record<string, unknown>>; deleted?: Array<{ id: string }>; runTransfers?: boolean }) => {
        const localBudgets = budgetsByDir.get(activeDataDir)!;
        if (method === "get-budgets") return [...localBudgets];
        if (method === "close-budget") { activeBudget = null; return "ok"; }
        if (method === "schedule/force-run-service") return "ok";
        if (method === "schedule/skip-next-date") {
          const schedule = schedules.find(item => item.id === args?.id);
          if (schedule && typeof schedule.next_date === "string") {
            const date = new Date(`${schedule.next_date}T00:00:00Z`);
            date.setUTCDate(date.getUTCDate() + 1);
            schedule.next_date = date.toISOString().slice(0, 10);
          }
          return "ok";
        }
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
    getSchedules: vi.fn(async () => schedules),
    createSchedule: vi.fn(async (schedule: Record<string, unknown>) => {
      const id = `schedule-${schedules.length + 1}`;
      const ruleId = `schedule-rule-${schedules.length + 1}`;
      schedules.push({ ...schedule, id, rule: ruleId, next_date: (schedule.date as { start: string }).start, completed: false });
      rules.push({ id: ruleId, stage: null, conditionsOp: "and", conditions: [
        { field: "payee", op: "is", value: schedule.payee },
        { field: "account", op: "is", value: schedule.account },
        { field: "date", op: "isapprox", value: schedule.date },
        { field: "amount", op: schedule.amountOp, value: schedule.amount },
      ], actions: [{ op: "link-schedule", value: id }] });
      return id;
    }),
    updateSchedule: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      const schedule = schedules.find(item => item.id === id)!;
      Object.assign(schedule, fields);
      if (["amount", "amountOp", "account", "payee", "date"].some(key => key in fields)) {
        const rule = rules.find(item => item.id === schedule.rule)!;
        const conditions = rule.conditions as Array<Record<string, unknown>>;
        for (const condition of conditions) {
          if (condition.field === "amount") { condition.op = schedule.amountOp; condition.value = schedule.amount; }
          if (condition.field === "account") condition.value = schedule.account;
          if (condition.field === "payee") condition.value = schedule.payee;
          if (condition.field === "date") condition.value = schedule.date;
        }
      }
    }),
    deleteSchedule: vi.fn(async (id: string) => {
      const schedule = schedules.find(item => item.id === id);
      schedules.splice(schedules.indexOf(schedule!), 1);
    }),
    getRules: vi.fn(async () => rules),
    updateRule: vi.fn(async (rule: Record<string, unknown>) => {
      Object.assign(rules.find(item => item.id === rule.id)!, rule);
      return rule;
    }),
    getBudgetMonth: vi.fn(async (month: string) => ({
      month, incomeAvailable: 0, lastMonthOverspent: 0, forNextMonth: 0, totalBudgeted: 0,
      toBudget: 0, fromLastMonth: 0, totalIncome: 0, totalSpent: 0, totalBalance: 0,
      categoryGroups: [{ categories: [
        ...categories.filter(category => !category.is_income).map(category => ({
          id: category.id, budgeted: budgetValues.get(category.id) ?? 0,
        })),
        ...categories.filter(category => category.is_income).map(category => ({
          id: category.id, name: category.name, is_income: true, received: 123,
        })),
      ] }],
    })),
    setBudgetAmount: vi.fn(async (_month: string, categoryId: string, value: number) => { budgetValues.set(categoryId, value); }),
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
    getAccountBalance: vi.fn<(id: string) => Promise<number>>().mockResolvedValue(0),
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
    ...accountMetadata,
    api,
  } as unknown as ActualBrowserLedgerOptions;
  return { ledger: createActualBrowserLedger(options), api, rows, accounts, payees, categories, budgetValues, schedules, rules, selectedBudget, saveBudgetId, sendHandlers, budgets, budgetsByDir, getActiveBudget: () => activeBudget };
}

describe("Actual browser ledger", () => {
  it("creates and remembers an empty local budget with runImport", async () => {
    const { ledger, api, selectedBudget, getActiveBudget } = fixture();
    await expect(ledger.listOpenAccounts()).resolves.toEqual([{ id: "cash", name: "現金", accountType: "other" }, { id: "bank", name: "銀行", accountType: "other" }]);
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

  it("does not claim orphan cleanup when an import rejects before metadata can be enumerated", async () => {
    const { ledger, api, selectedBudget, saveBudgetId, sendHandlers, budgetsByDir } = fixture([{ id: "budget", name: "Existing" }]);
    api.importBudget.mockImplementationOnce(async () => {
      // Equivalent failure seam: a partial SQLite write never appears in get-budgets.
      expect(budgetsByDir.get("/failed/unlisted")).toEqual([]);
      throw new Error("synthetic metadata write failure before ID return");
    });
    await expect(ledger.restoreBackup(new Uint8Array([8]), "/failed/unlisted")).rejects.toBeInstanceOf(ActualRestoreIncompleteError);
    expect(sendHandlers.some(send => send.mock.calls.some(([method]) => method === "delete-budget"))).toBe(false);
    expect(selectedBudget.current).toBe("budget"); expect(saveBudgetId).not.toHaveBeenCalled();
    expect(api.init).toHaveBeenLastCalledWith({ dataDir: "/documents" });
    expect(budgetsByDir.get("/documents")).toEqual([{ id: "budget", name: "Existing" }]);
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
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-09" })).resolves.toEqual({
      yearMonth: "2026-09", incomeYen: 5000, expenseYen: 4284, balanceYen: 716,
      categories: [
        { categoryId: "food", categoryName: "食費", amountYen: 3884 },
        { categoryId: "home", categoryName: "住居費", amountYen: 400 },
      ],
    });
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

  it("aggregates by amount sign, excludes off-budget and tombstoned rows, and reports null categories", async () => {
    const { ledger, api, rows } = fixture([{ id: "budget", name: "Local" }]);
    rows.push(
      { id: "refund", account: "cash", date: "2026-09-25", amount: 250, category: "food" },
      { id: "negative-income", account: "cash", date: "2026-09-24", amount: -100, category: "income-category" },
      { id: "uncategorized", account: "cash", date: "2026-09-23", amount: -200, category: null },
      { id: "offbudget-spend", account: "offbudget", date: "2026-09-22", amount: -500, category: "food" },
      { id: "tombstone-spend", account: "cash", date: "2026-09-21", amount: -900, category: "food", tombstone: true },
      { id: "opening-balance", account: "cash", date: "2026-09-20", amount: 100000, starting_balance_flag: true },
      { id: "failed-import", account: "cash", date: "2026-09-19", amount: -800, category: "food", error: "invalid" },
    );
    api.getAccounts.mockImplementation(async () => [
      { id: "cash", name: "現金", closed: false }, { id: "offbudget", name: "投資口座", closed: false, offbudget: true },
    ]);
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-09" })).resolves.toEqual({
      yearMonth: "2026-09", incomeYen: 5250, expenseYen: 4584, balanceYen: 666,
      categories: [
        { categoryId: "food", categoryName: "食費", amountYen: 3884 },
        { categoryId: "home", categoryName: "住居費", amountYen: 400 },
        { categoryId: null, categoryName: "未分類", amountYen: 200 },
        { categoryId: "income-category", categoryName: "給与", amountYen: 100 },
      ],
    });
  });

  it("returns an empty summary for zero months and handles the last valid calendar month", async () => {
    const { ledger } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-10" })).resolves.toEqual({
      yearMonth: "2026-10", incomeYen: 0, expenseYen: 0, balanceYen: 0, categories: [],
    });
    expect(() => ledger.getMonthlySummary({ yearMonth: "0000-01" })).toThrow("Invalid yearMonth.");
    await expect(ledger.getMonthlySummary({ yearMonth: "9999-12" })).resolves.toMatchObject({ yearMonth: "9999-12", incomeYen: 0, expenseYen: 0 });
  });

  it("reads native category budgets, includes hidden expense categories, and scopes totals to budgeted categories", async () => {
    const { ledger } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.getMonthlyBudgets({ yearMonth: "2026-09" })).resolves.toEqual({
      yearMonth: "2026-09",
      categories: [
        { categoryId: "food", categoryName: "食費", budgetYen: 10000, spentYen: 3884, remainingYen: 6116, usageRatio: 0.3884 },
        { categoryId: "home", categoryName: "住居費", budgetYen: 5000, spentYen: 400, remainingYen: 4600, usageRatio: 0.08 },
        { categoryId: "hidden", categoryName: "旧カテゴリ", budgetYen: -200, spentYen: 0, remainingYen: -200, usageRatio: 0 },
      ],
      budgetYen: 15000, spentYen: 4284, remainingYen: 10716, usageRatio: 0.2856,
    });
  });

  it("sets a nonnegative budget only for expense categories and verifies Actual readback", async () => {
    const { ledger, api, budgetValues } = fixture([{ id: "budget", name: "Local" }]);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "food", budgetYen: 0 })).resolves.toBeUndefined();
    expect(api.setBudgetAmount).toHaveBeenCalledWith("2026-09", "food", 0);
    expect(budgetValues.get("food")).toBe(0);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "income-category", budgetYen: 100 })).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "missing", budgetYen: 100 })).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "food", budgetYen: -1 })).rejects.toBeInstanceOf(ActualMasterValidationError);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "food", budgetYen: Number.MAX_SAFE_INTEGER + 1 })).rejects.toBeInstanceOf(ActualMasterValidationError);
    expect(api.setBudgetAmount).toHaveBeenCalledTimes(1);
  });

  it("accepts Actual removing a zero budget row after clearing the native month amount", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    api.getBudgetMonth.mockResolvedValueOnce({
      month: "2026-09", incomeAvailable: 0, lastMonthOverspent: 0, forNextMonth: 0, totalBudgeted: 0,
      toBudget: 0, fromLastMonth: 0, totalIncome: 0, totalSpent: 0, totalBalance: 0, categoryGroups: [{ categories: [] }],
    });
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "food", budgetYen: 0 })).resolves.toBeUndefined();
  });

  it("rejects malformed budget values, unsafe totals, invalid months, and native readback mismatches", async () => {
    const { ledger, api, budgetValues } = fixture([{ id: "budget", name: "Local" }]);
    api.getBudgetMonth.mockResolvedValueOnce({
      month: "2026-09", incomeAvailable: 0, lastMonthOverspent: 0, forNextMonth: 0, totalBudgeted: 0,
      toBudget: 0, fromLastMonth: 0, totalIncome: 0, totalSpent: 0, totalBalance: 0,
      categoryGroups: [{ categories: [{ id: "food", budgeted: Number.MAX_SAFE_INTEGER + 1 }] }],
    });
    await expect(ledger.getMonthlyBudgets({ yearMonth: "2026-09" })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
    budgetValues.set("food", Number.MAX_SAFE_INTEGER);
    budgetValues.set("home", 1);
    await expect(ledger.getMonthlyBudgets({ yearMonth: "2026-09" })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
    expect(() => ledger.getMonthlyBudgets({ yearMonth: "0000-01" })).toThrow("Invalid yearMonth.");
    api.setBudgetAmount.mockResolvedValueOnce(undefined);
    api.getBudgetMonth.mockResolvedValueOnce({
      month: "2026-09", incomeAvailable: 0, lastMonthOverspent: 0, forNextMonth: 0, totalBudgeted: 0,
      toBudget: 0, fromLastMonth: 0, totalIncome: 0, totalSpent: 0, totalBalance: 0,
      categoryGroups: [{ categories: [{ id: "food", budgeted: 42 }] }],
    });
    budgetValues.set("food", 0);
    await expect(ledger.setMonthlyBudget({ yearMonth: "2026-09", categoryId: "food", budgetYen: 41 })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
  });

  it("creates schedules disabled until category rules are installed, retries matching names, and runs Actual's schedule service", async () => {
    const { ledger, api, schedules, rules, sendHandlers } = fixture([{ id: "budget", name: "Local" }]);
    const input = {
      name: "家賃", kind: "expense" as const, amountYen: 80000, categoryId: "home", accountId: "cash",
      frequency: "monthly" as const, startDate: "2026-09-27", postsTransaction: true,
    };
    await expect(ledger.createRecurringSchedule(input)).resolves.toMatchObject({
      id: "schedule-1", name: "家賃", kind: "expense", amountYen: 80000, categoryId: "home", frequency: "monthly", editable: true,
    });
    expect(api.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ posts_transaction: false, amount: -80000, amountOp: "is" }));
    expect(rules[0]?.actions).toEqual([
      { op: "link-schedule", value: "schedule-1" }, { field: "category", op: "set", value: "home" },
    ]);
    expect(api.updateSchedule.mock.calls.map(([, fields]) => fields)).toEqual([{ posts_transaction: true }]);
    await expect(ledger.createRecurringSchedule(input)).resolves.toMatchObject({ id: "schedule-1", categoryId: "home" });
    expect(api.createSchedule).toHaveBeenCalledTimes(1);
    expect(schedules).toHaveLength(1);
    expect(sendHandlers.some(send => send.mock.calls.some(([method]) => method === "schedule/force-run-service"))).toBe(true);
  });

  it("repairs a durable disabled native schedule after category rule persistence fails", async () => {
    const { ledger, api, schedules, rules } = fixture([{ id: "budget", name: "Local" }]);
    const input = {
      name: "保険料", kind: "expense" as const, amountYen: 1200, categoryId: "home", accountId: "cash",
      frequency: "yearly" as const, startDate: "2026-10-01", postsTransaction: true,
    };
    api.updateRule.mockRejectedValueOnce(new Error("write failed"));
    await expect(ledger.createRecurringSchedule(input)).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
    expect(schedules[0]?.posts_transaction).toBe(false);
    await expect(ledger.createRecurringSchedule(input)).resolves.toMatchObject({ id: "schedule-1", editable: true });
    expect(api.createSchedule).toHaveBeenCalledTimes(1);
    expect(schedules[0]?.posts_transaction).toBe(true);
    expect(rules[0]?.actions).toContainEqual({ field: "category", op: "set", value: "home" });
  });

  it("updates editable schedules without replacing unrelated rule actions and can delete unsupported schedules", async () => {
    const { ledger, api, schedules, rules } = fixture([{ id: "budget", name: "Local" }]);
    schedules.push({
      id: "external", name: "電気代", rule: "rule-external", posts_transaction: true, amount: -12000, amountOp: "is",
      account: "cash", payee: "shop", date: { frequency: "monthly", interval: 1, start: "2026-01-01", endMode: "never" },
      next_date: "2026-10-01", completed: false,
    });
    rules.push({ id: "rule-external", stage: null, conditionsOp: "and", conditions: [
      { field: "payee", op: "is", value: "shop" }, { field: "account", op: "is", value: "cash" },
      { field: "date", op: "isapprox", value: schedules[0]?.date }, { field: "amount", op: "is", value: -12000 },
    ], actions: [
      { op: "link-schedule", value: "external" }, { field: "notes", op: "set", value: "keep me" },
      { field: "category", op: "set", value: "food" },
    ] });
    const replacement = {
      name: "電気代", kind: "expense" as const, amountYen: 13000, categoryId: "home", accountId: "cash",
      frequency: "monthly" as const, startDate: "2026-01-01", postsTransaction: true,
    };
    await expect(ledger.updateRecurringSchedule("external", replacement)).resolves.toMatchObject({ amountYen: 13000, categoryId: "home" });
    expect(rules[0]?.actions).toEqual([
      { op: "link-schedule", value: "external" }, { field: "notes", op: "set", value: "keep me" },
      { field: "category", op: "set", value: "home" },
    ]);
    expect(api.updateSchedule).toHaveBeenCalledWith("external", expect.objectContaining({ posts_transaction: false }));
    expect(api.updateSchedule).toHaveBeenCalledWith("external", expect.objectContaining({
      amount: -13000, date: { frequency: "monthly", interval: 1, start: "2026-01-01", endMode: "never" },
    }));
    expect(api.updateSchedule.mock.calls.find(([, fields]) => fields.amount === -13000)).toHaveLength(2);
    await expect(ledger.deleteRecurringSchedule("external")).resolves.toBeUndefined();
    await expect(ledger.deleteRecurringSchedule("external")).resolves.toBeUndefined();
    expect(schedules).toHaveLength(0);
  });

  it("returns search rows with split child metadata, one outgoing transfer, tombstones excluded, and closed accounts included", async () => {
    const { ledger, rows, accounts, payees } = fixture([{ id: "budget", name: "Local" }]);
    accounts.push({ id: "closed-card", name: "旧カード", closed: true });
    payees.push({ id: "market", name: "合成スーパー" });
    rows.find(row => row.id === "parent")!.category = "food";
    rows.find(row => row.id === "parent")!.payee = "shop";
    rows.find(row => row.id === "parent")!.notes = "親メモ";
    rows.find(row => row.id === "parent")!.schedule = "synthetic-schedule";
    rows.find(row => row.id === "split-a")!.payee = "market";
    rows.find(row => row.id === "split-a")!.notes = "子メモ米";
    rows.find(row => row.id === "split-b")!.notes = "子メモ日用品";
    rows.push(
      { id: "deleted-root", account: "cash", date: "2026-09-30", amount: -50, category: "food", tombstone: true },
      { id: "deleted-child", parent_id: "parent", is_child: true, account: "cash", date: "2026-09-27", amount: -1, category: "deleted-category", tombstone: true },
      { id: "closed-row", account: "closed-card", date: "2026-09-25", amount: -2500, category: "home", notes: "閉鎖口座も検索" },
    );
    rows.find(row => row.id === "transfer-in")!.account = "bank";
    const found = await ledger.getSearchTransactions();
    expect(found.find(row => row.transaction.id === "parent")).toMatchObject({
      categoryIds: ["food", "home"], keywordValues: ["Synthetic Store", "親メモ", "合成スーパー", "子メモ米", "子メモ日用品"],
      transaction: { isSplit: true, memo: "親メモ" }, recurringScheduleId: "synthetic-schedule",
    });
    expect(found.filter(row => row.transaction.kind === "transfer")).toHaveLength(1);
    expect(found.find(row => row.transaction.id === "transfer-out")?.transaction.transferAccountId).toBe("bank");
    expect(found.some(row => row.transaction.id === "transfer-in" || row.transaction.id === "deleted-root" || row.categoryIds.includes("deleted-category"))).toBe(false);
    expect(found.find(row => row.transaction.id === "closed-row")?.transaction.accountId).toBe("closed-card");
  });

  it("searches the full Actual date range independently of recent-row limits and validates explicit dates", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Local" }]);
    for (let index = 0; index < 125; index += 1) {
      rows.push({ id: `old-${index.toString().padStart(3, "0")}`, account: "cash", date: "2001-01-01", amount: -1, category: "food" });
    }
    const results = await ledger.getSearchTransactions();
    const oldRows = results.filter(row => row.transaction.date === "2001-01-01");
    expect(oldRows).toHaveLength(125);
    expect(oldRows[0]?.transaction.id).toBe("old-124");
    expect(oldRows.at(-1)?.transaction.id).toBe("old-000");
    await expect(ledger.getSearchTransactions({ startDate: "2001-01-01", endDate: "2001-01-01" })).resolves.toHaveLength(125);
    await expect(ledger.getTransactionById("old-000")).resolves.toMatchObject({ id: "old-000", date: "2001-01-01", amountYen: -1 });
    expect(() => ledger.getSearchTransactions({ startDate: "2026-02-30" })).toThrow("Invalid transaction date.");
    expect(() => ledger.getSearchTransactions({ endDate: "2026/09/01" })).toThrow("Invalid transaction date.");
    expect(() => ledger.getSearchTransactions({ startDate: "2027-01-01", endDate: "2026-01-01" })).toThrow("Start date must not follow end date.");
  });

  it("keeps complex schedules visible but read-only and advances only deleted due occurrences", async () => {
    const { ledger, schedules, rules, sendHandlers } = fixture([{ id: "budget", name: "Local" }]);
    schedules.push({
      id: "complex", name: "複雑な定期取引", rule: "rule-complex", posts_transaction: true,
      amount: -100, amountOp: "is", account: "cash", payee: "shop",
      date: { frequency: "monthly", interval: 1, start: "2026-09-01", endMode: "never", patterns: [{ type: "day", value: 1 }] },
      next_date: "2026-09-01", completed: false,
    });
    rules.push({ id: "rule-complex", stage: null, conditionsOp: "and", conditions: [], actions: [{ op: "link-schedule", value: "complex" }] });
    await expect(ledger.listRecurringSchedules()).resolves.toMatchObject([{ id: "complex", editable: false }]);
    await expect(ledger.deleteRecurringSchedule("complex")).resolves.toBeUndefined();

    schedules.push({
      id: "due", name: "月額", rule: "rule-due", posts_transaction: true, amount: -1000, amountOp: "is", account: "cash", payee: "shop",
      date: { frequency: "monthly", interval: 1, start: "2026-09-01", endMode: "never" }, next_date: "2026-09-30", completed: false,
    });
    await ledger.skipDeletedScheduleOccurrences([
      { id: "occurrence", date: "2026-09-30", amount: -1000, account: "cash", schedule: "due" },
      { id: "stale", date: "2026-09-29", amount: -1000, account: "cash", schedule: "due" },
    ]);
    expect(schedules.find(schedule => schedule.id === "due")?.next_date).toBe("2026-10-01");
    await ledger.skipDeletedScheduleOccurrences([
      { id: "occurrence", date: "2026-09-30", amount: -1000, account: "cash", schedule: "due" },
    ]);
    expect(schedules.find(schedule => schedule.id === "due")?.next_date).toBe("2026-10-01");
    const skipCalls = sendHandlers.flatMap(send => send.mock.calls).filter(([method]) => method === "schedule/skip-next-date");
    expect(skipCalls).toHaveLength(1);
  });

  it("rejects unsafe monthly total and balance arithmetic", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Local" }]);
    rows.push({ id: "overflow", account: "cash", date: "2026-09-25", amount: -Number.MAX_SAFE_INTEGER, category: null });
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-09" })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
    await expect(ledger.getMonthlySpending({ yearMonth: "2026-09" })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
  });

  it("nets positive refund splits against spending in each category", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Local" }]);
    rows.splice(0, rows.length,
      { id: "net-split", account: "cash", date: "2026-09-15", amount: -300, is_parent: true },
      { id: "food-spend", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: -700, category: "food" },
      { id: "food-refund", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: 700, category: "food" },
      { id: "home-spend", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: -700, category: "home" },
      { id: "home-refund", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: 200, category: "home" },
      { id: "transport-spend", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: -100, category: "transport" },
      { id: "transport-refund", parent_id: "net-split", is_child: true, account: "cash", date: "2026-09-15", amount: 300, category: "transport" },
    );
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-09" })).resolves.toEqual({
      yearMonth: "2026-09", incomeYen: 0, expenseYen: 300, balanceYen: -300,
      categories: [
        { categoryId: "home", categoryName: "住居費", amountYen: 500 },
        { categoryId: "transport", categoryName: "カテゴリ名不明", amountYen: -200 },
      ],
    });
  });

  it("rejects an unsafe positive category denominator even when split net total is safe", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Local" }]);
    rows.splice(0, rows.length,
      { id: "large-net-split", account: "cash", date: "2026-09-15", amount: -Number.MAX_SAFE_INTEGER, is_parent: true },
      { id: "large-a", parent_id: "large-net-split", is_child: true, account: "cash", date: "2026-09-15", amount: -Number.MAX_SAFE_INTEGER, category: "food" },
      { id: "large-refund", parent_id: "large-net-split", is_child: true, account: "cash", date: "2026-09-15", amount: Number.MAX_SAFE_INTEGER, category: "transport" },
      { id: "large-b", parent_id: "large-net-split", is_child: true, account: "cash", date: "2026-09-15", amount: -Number.MAX_SAFE_INTEGER, category: "home" },
    );
    await expect(ledger.getMonthlySummary({ yearMonth: "2026-09" })).rejects.toBeInstanceOf(ActualBrowserUnavailableError);
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

  it("updates a receipt memo alone, clears it explicitly, and preserves legacy omitted memos", async () => {
    const { ledger, rows } = fixture([{ id: "budget", name: "Synthetic" }]);
    const receipt = rows.find(row => row.id === "expense")!;
    Object.assign(receipt, { imported_id: "kakeimatch:receipt:memo", notes: "old memo" });
    const input = { accountId: "cash", date: "2026-09-29", amountYen: -3284,
      merchant: "Synthetic Store", categoryId: "food", importedId: "kakeimatch:receipt:memo" };
    await ledger.editReceipt("expense", { ...input, memo: "new memo" });
    expect(receipt.notes).toBe("new memo");
    await ledger.editReceipt("expense", input);
    expect(receipt.notes).toBe("new memo");
    await ledger.editReceipt("expense", { ...input, memo: null });
    expect(receipt.notes).toBe("");
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

  it("adds catch-up rows explicitly without adopting a same-day manual transaction", async () => {
    const { ledger, api, rows, payees } = fixture([{ id: "budget", name: "Synthetic" }]);
    payees.push({ id: "same-payee", name: "Synthetic Market" });
    rows.push({ id: "manual-lookalike", account: "cash", date: "2026-09-29", amount: -1200, payee: "same-payee", category: "food", notes: null, imported_id: null });
    const input = { kind: "expense" as const, amountYen: 1200, date: "2026-09-29", payeeName: "Synthetic Market", categoryId: "food", accountId: "cash", memo: null,
      importedId: "kakeimatch:schedule:synthetic-schedule:2026-09-29" };
    const created = await ledger.createTransaction(input);
    expect(created.id).not.toBe("manual-lookalike");
    expect(rows.find(row => row.id === "manual-lookalike")?.imported_id).toBeNull();
    expect(rows.filter(row => row.imported_id === input.importedId)).toHaveLength(1);
    expect(api.importTransactions).not.toHaveBeenCalled();
    expect(api.addTransactions).toHaveBeenCalledWith("cash", [expect.objectContaining({ date: input.date, amount: -1200, payee: "same-payee", imported_id: input.importedId })],
      { learnCategories: false, runTransfers: false });
    await ledger.createTransaction(input);
    expect(api.addTransactions).toHaveBeenCalledTimes(1);
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

  it("returns signed balances for every account, including closed accounts, using Actual's default cutoff", async () => {
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }]);
    api.getAccountBalance.mockImplementation(async id => id === "cash" ? -1200 : id === "bank" ? 5000 : -45);
    await expect(ledger.getAccountBalances()).resolves.toEqual([
      { id: "cash", name: "現金", closed: false, accountType: "other", balanceYen: -1200 },
      { id: "bank", name: "銀行", closed: false, accountType: "other", balanceYen: 5000 },
      { id: "closed", name: "旧口座", closed: true, accountType: "other", balanceYen: -45 },
    ]);
    expect(api.getAccountBalance.mock.calls).toEqual([["cash"], ["bank"], ["closed"]]);
  });

  it("rejects unsafe balance values and surfaces provider failures", async () => {
    const invalid = fixture([{ id: "budget", name: "Local" }]);
    invalid.api.getAccountBalance.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER + 1);
    await expect(invalid.ledger.getAccountBalances()).rejects.toMatchObject({ reason: "invalid_data" });

    const failing = fixture([{ id: "budget", name: "Local" }]);
    failing.api.getAccountBalance.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(failing.ledger.getAccountBalances()).rejects.toMatchObject({ reason: "operation" });
  });

  it("reads and writes account types using Actual budget and account IDs", async () => {
    const values = new Map<string, "bank" | "credit_card" | "cash" | "other">();
    const getAccountType = vi.fn(async (budgetId: string, accountId: string) => values.get(`${budgetId}:${accountId}`) ?? null);
    const saveAccountType = vi.fn(async (budgetId: string, accountId: string, type: "bank" | "credit_card" | "cash" | "other" | null) => {
      if (type === null) values.delete(`${budgetId}:${accountId}`);
      else values.set(`${budgetId}:${accountId}`, type);
    });
    const { ledger, selectedBudget, budgets } = fixture([{ id: "budget", name: "Local" }], { getAccountType, saveAccountType });
    values.set("budget:bank", "credit_card");
    expect((await ledger.listAccounts()).find(account => account.id === "bank")?.accountType).toBe("credit_card");
    expect((await ledger.listAccounts()).find(account => account.id === "cash")?.accountType).toBe("other");
    await ledger.setAccountType("cash", "cash");
    expect(saveAccountType).toHaveBeenCalledWith("budget", "cash", "cash");
    await ledger.deleteAccount("closed");
    expect(saveAccountType).toHaveBeenCalledWith("budget", "closed", null);
    budgets.push({ id: "other-budget", name: "Other" });
    selectedBudget.current = "other-budget";
    expect((await ledger.listAccounts()).find(account => account.id === "bank")?.accountType).toBe("other");
  });

  it("rolls back a newly created account when its type cannot be saved", async () => {
    const metadataFailure = new Error("synthetic metadata failure");
    const { ledger, api } = fixture([{ id: "budget", name: "Local" }], { saveAccountType: vi.fn().mockRejectedValue(metadataFailure) });
    await expect(ledger.addAccount("新しい口座", "cash")).rejects.toMatchObject({ reason: "operation", cause: metadataFailure });
    expect(api.createAccount).toHaveBeenCalledOnce();
    expect(api.deleteAccount).toHaveBeenCalledWith("new-account");

    const rollbackFailure = new Error("synthetic rollback failure");
    const second = fixture([{ id: "budget", name: "Local" }], { saveAccountType: vi.fn().mockRejectedValue(metadataFailure) });
    second.api.deleteAccount.mockRejectedValueOnce(rollbackFailure);
    await expect(second.ledger.addAccount("新しい口座", "cash")).rejects.toMatchObject({
      reason: "operation",
      cause: expect.objectContaining({ errors: [metadataFailure, rollbackFailure] }),
    });
  });

  it("requires a persistence hook before changing an account type", async () => {
    const { ledger } = fixture([{ id: "budget", name: "Local" }]);
    expect(() => ledger.setAccountType("cash", "cash")).toThrow("保存できません");
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
