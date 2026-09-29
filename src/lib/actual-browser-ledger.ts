"use client";

import { z } from "zod";
import type { ActualAccount, ActualCategory, ActualLedger, ActualTransaction } from "@/lib/actual-ledger";

type ActualApi = Pick<typeof import("@actual-app/api"),
  | "init" | "getBudgets" | "runImport" | "loadBudget" | "getAccounts" | "getCategories"
  | "getBudgetMonths" | "getTransactions" | "importTransactions" | "updateTransaction"
  | "createCategory" | "updateCategory" | "getPayees" | "batchBudgetUpdates"
>;

const dateSchema = z.iso.date();
const idSchema = z.string().min(1).max(128);
const actualTransactionSchema = z.object({
  id: idSchema,
  date: dateSchema,
  amount: z.number().int().safe(),
  account: idSchema,
  payee: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  cleared: z.boolean().optional(),
  transfer_id: z.string().nullable().optional(),
  is_parent: z.boolean().optional(),
});

export class ActualBudgetSelectionRequiredError extends Error {
  constructor() {
    super("Choose a local budget before continuing.");
    this.name = "ActualBudgetSelectionRequiredError";
  }
}

export class ActualBrowserUnavailableError extends Error {
  constructor(readonly reason: "storage" | "invalid_data" | "operation") {
    super("The local budget is temporarily unavailable.");
    this.name = "ActualBrowserUnavailableError";
  }
}

export type ActualBrowserLedgerOptions = {
  /** Device-local profile state. Never pass a Cloudflare user or session ID. */
  getBudgetId: () => string | null;
  saveBudgetId: (budgetId: string) => void | Promise<void>;
  newBudgetName?: () => string;
  /** Injection seam for deterministic unit tests. Production lazily loads the browser export. */
  api?: ActualApi;
};

type NativeTransaction = z.infer<typeof actualTransactionSchema> & {
  imported_id?: string;
  is_child?: boolean;
};

type RuntimeState = { initialized: boolean; loadedBudgetId?: string; tail: Promise<void> };
const runtimeByApi = new WeakMap<object, RuntimeState>();

function runtimeFor(api: ActualApi): RuntimeState {
  let state = runtimeByApi.get(api);
  if (!state) {
    state = { initialized: false, tail: Promise.resolve() };
    runtimeByApi.set(api, state);
  }
  return state;
}

function mapTransaction(value: unknown, names: { payees: Map<string, string>; categories: Map<string, string> }): ActualTransaction {
  const parsed = actualTransactionSchema.safeParse(value);
  if (!parsed.success) throw new ActualBrowserUnavailableError("invalid_data");
  const row = parsed.data;
  return {
    id: row.id,
    date: row.date,
    amountYen: row.amount,
    kind: row.transfer_id ? "transfer" : row.amount < 0 ? "expense" : "income",
    payeeName: row.payee ? names.payees.get(row.payee) ?? null : null,
    categoryName: row.category ? names.categories.get(row.category) ?? null : null,
    accountId: row.account,
    cleared: row.cleared ?? false,
  };
}

function validateDate(value: string): string {
  if (!dateSchema.safeParse(value).success) throw new Error("Invalid transaction date.");
  return value;
}

function todayInTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function lastDayOfMonth(yearMonth: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) throw new Error("Invalid yearMonth.");
  const next = new Date(`${yearMonth}-01T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * A domain-facing adapter over Actual's browser API. The Actual module is loaded only
 * when an operation runs, so this module never pulls the Node export into server code.
 */
export function createActualBrowserLedger(options: ActualBrowserLedgerOptions): ActualLedger & {
  listOpenAccounts(): Promise<ActualAccount[]>;
  listExpenseCategories(): Promise<ActualCategory[]>;
  createExpenseCategory(name: string, groupId: string): Promise<string>;
  renameCategory(id: string, name: string): Promise<void>;
  importReceipt(input: {
    accountId: string;
    date: string;
    amountYen: number;
    merchant: string;
    categoryId: string;
    importedId: string;
  }): Promise<ActualTransaction>;
  updateReceipt(id: string, changes: { categoryId?: string; cleared?: boolean }): Promise<void>;
  applyTransactionUpdates(updates: Array<{ transactionId: string; amountYen?: number; cleared: true }>): Promise<void>;
} {
  let apiPromise: Promise<ActualApi> | undefined;

  const getApi = async (): Promise<ActualApi> => {
    if (options.api) return options.api;
    apiPromise ??= import("@actual-app/api").then((module) => module as ActualApi);
    return apiPromise;
  };

  const withBudget = <T>(operation: (api: ActualApi) => Promise<T>): Promise<T> => getApi().then((api) => {
    const runtime = runtimeFor(api);
    const run = async () => {
    try {
      if (!runtime.initialized) {
        await api.init({});
        runtime.initialized = true;
      }

      let budgets = await api.getBudgets();
      let selectedId = options.getBudgetId();
      if (budgets.length === 0) {
        const name = options.newBudgetName?.() ?? "KakeiMatch";
        await api.runImport(name, async () => {});
        budgets = await api.getBudgets();
        if (budgets.length !== 1 || !budgets[0]?.id) throw new ActualBrowserUnavailableError("storage");
        selectedId = budgets[0].id;
        await options.saveBudgetId(selectedId);
      } else if (!selectedId && budgets.length === 1) {
        selectedId = budgets[0]?.id ?? null;
        if (selectedId) await options.saveBudgetId(selectedId);
      } else if (!selectedId) {
        throw new ActualBudgetSelectionRequiredError();
      }

      if (!selectedId || !budgets.some((budget) => budget.id === selectedId)) {
        throw new ActualBudgetSelectionRequiredError();
      }
      if (runtime.loadedBudgetId !== selectedId) {
        await api.loadBudget(selectedId);
        runtime.loadedBudgetId = selectedId;
      }
      return await operation(api);
    } catch (error) {
      if (error instanceof ActualBudgetSelectionRequiredError || error instanceof ActualBrowserUnavailableError) throw error;
      throw new ActualBrowserUnavailableError("operation");
    }
    };
    const result = runtime.tail.then(run, run);
    runtime.tail = result.then(() => undefined, () => undefined);
    return result;
  });

  const allRows = async (api: ActualApi, startDate: string, endDate: string): Promise<NativeTransaction[]> => {
    const accounts = await api.getAccounts();
    const lists = await Promise.all(accounts.map((account) => api.getTransactions(account.id, startDate, endDate)));
    return lists.flat() as NativeTransaction[];
  };

  const visibleRows = (rows: NativeTransaction[]) => rows.filter((row) => !row.is_parent);

  const namesFor = async (api: ActualApi) => {
    const [payees, categories] = await Promise.all([api.getPayees(), api.getCategories()]);
    return {
      payees: new Map(payees.map((payee) => [payee.id, payee.name])),
      categories: new Map(categories.map((category) => [category.id, category.name])),
    };
  };

  const listCategories = async (api: ActualApi) => {
    const categories = await api.getCategories();
    return categories.filter((category) => !category.hidden && !category.is_income)
      .map((category) => ({ id: category.id, name: category.name }));
  };

  return {
    getRecentTransactions({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid transaction limit.");
      return withBudget(async (api) => {
        const months = (await api.getBudgetMonths()).toSorted();
        if (months.length === 0) return [];
        const rows = visibleRows(await allRows(api, `${months[0]}-01`, todayInTokyo()));
        rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        const names = await namesFor(api);
        return rows.slice(0, limit).map((row) => mapTransaction(row, names));
      });
    },

    getTransactions({ startDate, endDate }) {
      const start = validateDate(startDate);
      const end = validateDate(endDate);
      if (start > end) throw new Error("Start date must not follow end date.");
      return withBudget(async (api) => {
        const [rows, names] = await Promise.all([allRows(api, start, end), namesFor(api)]);
        return visibleRows(rows).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
          .map((row) => mapTransaction(row, names));
      });
    },

    getTransactionById(id) {
      const parsedId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(id);
      if (!parsedId.success) return Promise.resolve(null);
      return withBudget(async (api) => {
        const today = todayInTokyo();
        const months = (await api.getBudgetMonths()).toSorted();
        if (months.length === 0) return null;
        const rows = await allRows(api, `${months[0]}-01`, today);
        const row = rows.find((transaction) => transaction.id === parsedId.data && !transaction.is_parent);
        return row ? mapTransaction(row, await namesFor(api)) : null;
      });
    },

    getMonthlySpending({ yearMonth }) {
      const end = lastDayOfMonth(yearMonth);
      return withBudget(async (api) => {
        const rows = await allRows(api, `${yearMonth}-01`, end);
        let total = 0;
        for (const row of rows) {
          if (row.is_parent || row.transfer_id || row.amount >= 0) continue;
          total += -row.amount;
          if (!Number.isSafeInteger(total)) throw new ActualBrowserUnavailableError("invalid_data");
        }
        return total;
      });
    },

    listOpenAccounts() {
      return withBudget(async (api) => (await api.getAccounts())
        .filter((account) => !account.closed).map(({ id, name }) => ({ id, name })));
    },

    listExpenseCategories() { return withBudget(listCategories); },

    createExpenseCategory(name, groupId) {
      const parsed = z.object({ name: z.string().trim().min(1).max(100), groupId: idSchema }).safeParse({ name, groupId });
      if (!parsed.success) throw new Error("Invalid Actual category.");
      return withBudget((api) => api.createCategory({ name: parsed.data.name, group_id: parsed.data.groupId, is_income: false, hidden: false }));
    },

    renameCategory(id, name) {
      const parsed = z.object({ id: idSchema, name: z.string().trim().min(1).max(100) }).safeParse({ id, name });
      if (!parsed.success) throw new Error("Invalid Actual category.");
      return withBudget(async (api) => { await api.updateCategory(parsed.data.id, { name: parsed.data.name }); });
    },

    async importReceipt(input) {
      const parsed = z.object({
        accountId: idSchema,
        date: dateSchema,
        amountYen: z.number().int().safe().negative(),
        merchant: z.string().trim().min(1).max(200),
        categoryId: idSchema,
        importedId: z.string().min(1).max(200),
      }).safeParse(input);
      if (!parsed.success) throw new Error("Invalid Actual receipt transaction.");
      return withBudget(async (api) => {
        const accounts = await api.getAccounts();
        if (!accounts.some((account) => account.id === parsed.data.accountId && !account.closed)) {
          throw new Error("Choose an open account.");
        }
        const result = await api.importTransactions(parsed.data.accountId, [{
          account: parsed.data.accountId,
          date: parsed.data.date,
          amount: parsed.data.amountYen,
          payee_name: parsed.data.merchant,
          category: parsed.data.categoryId,
          imported_id: parsed.data.importedId,
          cleared: false,
        }]);
        if (result.errors.length > 0) throw new ActualBrowserUnavailableError("invalid_data");
        const rows = await api.getTransactions(parsed.data.accountId, parsed.data.date, parsed.data.date) as NativeTransaction[];
        const saved = rows.find((row) => row.imported_id === parsed.data.importedId);
        if (!saved) throw new ActualBrowserUnavailableError("invalid_data");
        const transaction = mapTransaction(saved, await namesFor(api));
        if (saved.account !== parsed.data.accountId || saved.date !== parsed.data.date ||
          transaction.amountYen !== parsed.data.amountYen || transaction.payeeName !== parsed.data.merchant ||
          saved.category !== parsed.data.categoryId || transaction.kind !== "expense") {
          throw new ActualBrowserUnavailableError("invalid_data");
        }
        return transaction;
      });
    },

    updateReceipt(id, changes) {
      const parsed = z.object({
        id: idSchema,
        changes: z.object({ categoryId: idSchema.optional(), cleared: z.boolean().optional() }).strict(),
      }).safeParse({ id, changes });
      if (!parsed.success || Object.keys(parsed.data.changes).length === 0) throw new Error("Invalid Actual receipt update.");
      return withBudget(async (api) => {
        await api.batchBudgetUpdates(async () => {
          await api.updateTransaction(parsed.data.id, {
            ...(parsed.data.changes.categoryId ? { category: parsed.data.changes.categoryId } : {}),
            ...(parsed.data.changes.cleared === undefined ? {} : { cleared: parsed.data.changes.cleared }),
          });
        });
      });
    },

    applyTransactionUpdates(updates) {
      const parsed = z.array(z.object({
        transactionId: idSchema,
        amountYen: z.number().int().safe().negative().optional(),
        cleared: z.literal(true),
      }).strict()).min(1).max(500).safeParse(updates);
      if (!parsed.success || new Set(parsed.data.map(({ transactionId }) => transactionId)).size !== parsed.data.length) {
        throw new Error("Invalid Actual reconciliation batch.");
      }
      return withBudget(async (api) => {
        await api.batchBudgetUpdates(async () => {
          for (const update of parsed.data) {
            await api.updateTransaction(update.transactionId, {
              ...(update.amountYen === undefined ? {} : { amount: update.amountYen }),
              cleared: true,
            });
          }
        });
      });
    },
  };
}
