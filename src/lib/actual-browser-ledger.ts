"use client";

import { z } from "zod";
import { normalizeMerchant } from "./category";
import type { ActualAccount, ActualCategory, ActualLedger, ActualTransaction, ManualTransactionInput, TransferInput, TransferUpdateInput } from "@/lib/actual-ledger";

type ActualApi = Pick<typeof import("@actual-app/api"),
  | "init" | "shutdown" | "getBudgets" | "runImport" | "loadBudget" | "getAccounts" | "getCategories"
  | "getBudgetMonths" | "getTransactions" | "importTransactions" | "addTransactions" | "updateTransaction"
  | "createCategory" | "updateCategory" | "getPayees" | "createPayee" | "batchBudgetUpdates"
  | "exportBudget" | "importBudget"
  | "getCategoryGroups" | "createCategoryGroup" | "deleteCategory"
  | "createAccount" | "updateAccount" | "closeAccount" | "reopenAccount" | "deleteAccount" | "getAccountBalance"
>;
type ActualSend = Awaited<ReturnType<ActualApi["init"]>>["send"];

const dateSchema = z.iso.date();
const idSchema = z.string().min(1).max(128);
const manualTransactionSchema = z.object({
  kind: z.enum(["expense", "income"]),
  amountYen: z.number().int().safe().positive(),
  date: dateSchema,
  payeeName: z.string().trim().min(1).max(200),
  categoryId: idSchema,
  accountId: idSchema,
  memo: z.string().max(2000),
  importedId: z.string().min(1).max(200),
}).strict();
const actualTransactionSchema = z.object({
  id: idSchema,
  date: dateSchema,
  amount: z.number().int().safe(),
  account: idSchema,
  payee: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  cleared: z.boolean().optional(),
  reconciled: z.boolean().optional(),
  sort_order: z.number().optional(),
  transfer_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  imported_id: z.string().nullable().optional(),
  is_parent: z.boolean().optional(),
  is_child: z.boolean().optional(),
  parent_id: idSchema.nullable().optional(),
  subtransactions: z.array(z.object({
    id: idSchema.optional(),
    amount: z.number().int().safe(),
    category: idSchema.nullable().optional(),
  })).optional(),
});

/** Portable scalar values needed to delete or restore an entire native transaction group. */
export const nativeTransactionSnapshotSchema = actualTransactionSchema.omit({ subtransactions: true }).extend({
  error: z.object({ type: z.literal("SplitTransactionError"), version: z.literal(1), difference: z.number().int().safe() }).strict().nullable().optional(), imported_payee: z.string().nullable().optional(),
  starting_balance_flag: z.boolean().optional(), schedule: z.string().nullable().optional(),
}).strict();
export type NativeTransactionSnapshot = z.infer<typeof nativeTransactionSnapshotSchema>;

export class ActualMasterValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ActualMasterValidationError"; }
}

export type ManagedCategory = { id: string; name: string; isIncome: boolean; hidden: boolean; groupName: string };
export type ManagedAccount = { id: string; name: string; closed: boolean };

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

export class ActualRestoreTargetExistsError extends Error {
  constructor() {
    super("The local restore target already contains a budget.");
    this.name = "ActualRestoreTargetExistsError";
  }
}

export class ActualRestoreIncompleteError extends Error {
  constructor(cause?: unknown) {
    super("元の家計データは保持されています。復元先にデータの一部が残っている可能性があります。", { cause });
    this.name = "ActualRestoreIncompleteError";
  }
}

export type ActualBrowserLedgerOptions = {
  /** Device-local profile state. Never pass a Cloudflare user or session ID. */
  getBudgetId: () => string | null;
  saveBudgetId: (budgetId: string) => void | Promise<void>;
  /** Browser Actual virtual filesystem directory. Defaults to Actual's /documents. */
  getDataDir?: () => string;
  newBudgetName?: () => string;
  /** Injection seam for deterministic unit tests. Production lazily loads the browser export. */
  api?: ActualApi;
};

type NativeTransaction = z.infer<typeof actualTransactionSchema>;
// Actual stores null categories on split parents even though its public model omits null.
type ActualBatchTransaction = {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee?: string | null;
  category?: string | null;
  parent_id?: string | null;
  notes?: string;
  imported_id?: string;
  cleared?: boolean;
  reconciled?: boolean;
  is_parent?: boolean;
  is_child?: boolean;
  sort_order?: number;
};

type RuntimeState = { initialized: boolean; dataDir?: string; loadedBudgetId?: string; send?: ActualSend; tail: Promise<void> };
const runtimeByApi = new WeakMap<object, RuntimeState>();

function runtimeFor(api: ActualApi): RuntimeState {
  let state = runtimeByApi.get(api);
  if (!state) {
    state = { initialized: false, tail: Promise.resolve() };
    runtimeByApi.set(api, state);
  }
  return state;
}

function mapTransaction(value: unknown, names: { payees: Map<string, string>; categories: Map<string, string> }, transferAccountId: string | null = null): ActualTransaction {
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
    categoryId: row.category ?? null,
    memo: row.notes ?? null,
    importedId: row.imported_id ?? null,
    isSplit: Boolean(row.is_parent || row.subtransactions?.length),
    transferId: row.transfer_id ?? null,
    transferAccountId: row.transfer_id ? transferAccountId : null,
  };
}

function readBackSplitSet(parent: NativeTransaction, rows: NativeTransaction[]) {
  const children = parent.subtransactions?.length
    ? parent.subtransactions
    : rows.filter(row => row.parent_id === parent.id);
  return children.map(child => ({ categoryId: child.category ?? "", amountYen: child.amount }));
}

function sameSplitSet(actual: Array<{ categoryId: string; amountYen: number }>, expected: Array<{ categoryId: string; amountYen: number }>) {
  const key = (split: { categoryId: string; amountYen: number }) => `${split.categoryId}\0${split.amountYen}`;
  const actualSorted = actual.map(key).sort();
  const expectedSorted = expected.map(key).sort();
  return actualSorted.length === expectedSorted.length && actualSorted.every((value, index) => value === expectedSorted[index]);
}

function validateDate(value: string): string {
  if (!dateSchema.safeParse(value).success) throw new Error("Invalid transaction date.");
  return value;
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
  listIncomeCategories(): Promise<ActualCategory[]>;
  listCategories(): Promise<ManagedCategory[]>;
  addCategory(name: string, isIncome: boolean): Promise<string>;
  setCategoryHidden(id: string, hidden: boolean): Promise<void>;
  getCategoryUsage(id: string): Promise<number>;
  deleteCategory(id: string): Promise<void>;
  listAccounts(): Promise<ManagedAccount[]>;
  addAccount(name: string): Promise<string>;
  renameAccount(id: string, name: string): Promise<void>;
  getAccountUsage(id: string): Promise<{ transactionCount: number; balanceYen: number }>;
  closeAccount(id: string): Promise<void>;
  reopenAccount(id: string): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  createExpenseCategory(name: string, groupId: string): Promise<string>;
  renameCategory(id: string, name: string): Promise<void>;
  importReceipt(input: {
    accountId: string;
    date: string;
    amountYen: number;
    merchant: string;
    categoryId: string;
    importedId: string;
    splits?: Array<{ categoryId: string; amountYen: number }>;
  }): Promise<ActualTransaction>;
  editReceipt(id: string, input: {
    accountId: string;
    date: string;
    amountYen: number;
    merchant: string;
    categoryId: string;
    importedId: string;
    splits?: Array<{ categoryId: string; amountYen: number }>;
  }): Promise<ActualTransaction>;
  createTransaction(input: ManualTransactionInput): Promise<ActualTransaction>;
  updateTransaction(id: string, input: Omit<ManualTransactionInput, "importedId">): Promise<ActualTransaction>;
  createTransfer(input: TransferInput): Promise<ActualTransaction>;
  updateTransfer(id: string, input: TransferUpdateInput): Promise<ActualTransaction>;
  getTransactionTree(id: string): Promise<NativeTransactionSnapshot[]>;
  deleteTransactionTree(snapshot: NativeTransactionSnapshot[]): Promise<void>;
  restoreTransactionTree(snapshot: NativeTransactionSnapshot[]): Promise<void>;
  updateReceipt(id: string, changes: { categoryId?: string; cleared?: boolean }): Promise<void>;
  applyTransactionUpdates(updates: Array<{ transactionId: string; amountYen?: number; cleared: true }>): Promise<void>;
  exportBackup(): Promise<Uint8Array>;
  restoreBackup(data: Uint8Array, dataDir: string): Promise<string>;
  listLocalBudgets(): Promise<Array<{ id: string; name: string }>>;
  deleteLocalBudget(id: string): Promise<void>;
  discardDataDirectory(dataDir: string): Promise<void>;
} {
  let apiPromise: Promise<ActualApi> | undefined;

  const getApi = async (): Promise<ActualApi> => {
    if (options.api) return options.api;
    apiPromise ??= import("@actual-app/api").then((module) => module as ActualApi);
    return apiPromise;
  };

  const dataDirFor = () => options.getDataDir?.() ?? "/documents";

  const assertDataDir = (dataDir: string) => {
    if (!dataDir.startsWith("/") || dataDir.includes("\\") || dataDir.includes("\0") ||
      dataDir.split("/").some((part) => part === "..")) {
      throw new Error("Invalid Actual data directory.");
    }
  };

  const activateDataDir = async (api: ActualApi, runtime: RuntimeState, dataDir: string) => {
    assertDataDir(dataDir);
    if (runtime.initialized && runtime.dataDir === dataDir) return;
    if (runtime.initialized) await api.shutdown();
    runtime.initialized = false;
    runtime.dataDir = undefined;
    runtime.loadedBudgetId = undefined;
    runtime.send = (await api.init({ dataDir })).send as ActualSend;
    runtime.initialized = true;
    runtime.dataDir = dataDir;
  };

  const localBudgets = async (api: ActualApi) => {
    const send = runtimeFor(api).send;
    if (!send) throw new ActualBrowserUnavailableError("storage");
    return await send("get-budgets") as Array<{ id: string; name: string }>;
  };

  const cleanupDataDir = async (api: ActualApi, runtime: RuntimeState, dataDir: string) => {
    if (runtime.dataDir !== dataDir || !runtime.send) await activateDataDir(api, runtime, dataDir);
    const send = runtime.send!;
    const closeResult = await send("close-budget");
    if (closeResult !== "ok") throw new ActualBrowserUnavailableError("operation");
    runtime.loadedBudgetId = undefined;
    for (const budget of await localBudgets(api)) {
      const deleted = await send("delete-budget", { id: budget.id });
      if (deleted !== "ok") throw new ActualBrowserUnavailableError("operation");
    }
  };

  const withApi = <T>(operation: (api: ActualApi, runtime: RuntimeState) => Promise<T>): Promise<T> => getApi().then((api) => {
    const runtime = runtimeFor(api);
    const run = async () => {
      try {
        await activateDataDir(api, runtime, dataDirFor());
        return await operation(api, runtime);
      } catch (error) {
        if (error instanceof ActualBrowserUnavailableError) throw error;
        throw new ActualBrowserUnavailableError("operation");
      }
    };
    const result = runtime.tail.then(run, run);
    runtime.tail = result.then(() => undefined, () => undefined);
    return result;
  });

  const withBudget = <T>(operation: (api: ActualApi) => Promise<T>): Promise<T> => getApi().then((api) => {
    const runtime = runtimeFor(api);
    const run = async () => {
    try {
      await activateDataDir(api, runtime, dataDirFor());

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
      if (error instanceof ActualBudgetSelectionRequiredError || error instanceof ActualBrowserUnavailableError || error instanceof ActualMasterValidationError) throw error;
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
    const rows = lists.flat() as NativeTransaction[];
    const ids = new Set(rows.map(row => row.id));
    // The public API groups split children beneath their parent. Expand them
    // internally for category usage and spending, without counting a child twice.
    const children = rows.flatMap(parent => (parent.subtransactions ?? []).filter(child => !child.id || !ids.has(child.id)).map(child => {
      if (!child.id) throw new ActualBrowserUnavailableError("invalid_data");
      return { ...parent, ...child, id: child.id, is_parent: false, is_child: true, parent_id: parent.id, subtransactions: undefined };
    }));
    return [...rows, ...children];
  };

  // Keep the split parent
  // as the single receipt/reconciliation row and leave children to Actual's UI.
  const visibleRows = (rows: NativeTransaction[]) => rows.filter((row) => !row.is_child && !row.parent_id);

  const namesFor = async (api: ActualApi) => {
    const [payees, categories] = await Promise.all([api.getPayees(), api.getCategories()]);
    return {
      payees: new Map(payees.map((payee) => [payee.id, payee.name])),
      categories: new Map(categories.map((category) => [category.id, category.name])),
    };
  };

  const listCategories = async (api: ActualApi) => {
    const [categories, groups] = await Promise.all([api.getCategories(), api.getCategoryGroups()]);
    return categories.filter((category) => !category.hidden && !category.is_income && !groups.find(g => g.id === category.group_id)?.hidden)
      .map((category) => ({ id: category.id, name: category.name }));
  };

  const listIncomeCategories = async (api: ActualApi) => {
    const [categories, groups] = await Promise.all([api.getCategories(), api.getCategoryGroups()]);
    return categories.filter((category) => !category.hidden && category.is_income && !groups.find(g => g.id === category.group_id)?.hidden)
      .map((category) => ({ id: category.id, name: category.name }));
  };

  const validateManualInput = (input: unknown, includeImportedId: boolean) => {
    const schema = includeImportedId ? manualTransactionSchema : manualTransactionSchema.omit({ importedId: true });
    const normalized = input && typeof input === "object" ? { ...input, memo: (input as { memo?: string | null }).memo ?? "" } : input;
    const parsed = schema.safeParse(normalized);
    if (!parsed.success || (!includeImportedId && input && typeof input === "object" && "importedId" in input)) {
      throw new ActualMasterValidationError("取引内容を確認して入力し直してください。");
    }
    return parsed.data;
  };

  const validateManualMasters = async (api: ActualApi, input: Omit<ManualTransactionInput, "importedId"> | ManualTransactionInput) => {
    const [accounts, categories, groups] = await Promise.all([api.getAccounts(), api.getCategories(), api.getCategoryGroups()]);
    if (!accounts.some(account => account.id === input.accountId && !account.closed)) {
      throw new ActualMasterValidationError("利用中の支払元を選び直してください。");
    }
    const category = categories.find(candidate => candidate.id === input.categoryId);
    const group = category && groups.find(candidate => candidate.id === category.group_id);
    const shouldBeIncome = input.kind === "income";
    if (!category || category.hidden || category.is_income !== shouldBeIncome || group?.hidden) {
      throw new ActualMasterValidationError(shouldBeIncome ? "収入カテゴリを選び直してください。" : "支出カテゴリを選び直してください。");
    }
  };

  const verifyManualReadback = async (
    row: NativeTransaction | undefined,
    input: Omit<ManualTransactionInput, "importedId"> | ManualTransactionInput,
    importedId: string | null,
    api: ActualApi,
  ): Promise<ActualTransaction> => {
    if (!row) throw new ActualBrowserUnavailableError("invalid_data");
    const transaction = mapTransaction(row, await namesFor(api));
    const expectedAmount = input.kind === "expense" ? -input.amountYen : input.amountYen;
    if (row.account !== input.accountId || row.date !== input.date || row.amount !== expectedAmount ||
      normalizeMerchant(transaction.payeeName ?? "") !== normalizeMerchant(input.payeeName) ||
      row.category !== input.categoryId || (row.notes ?? "") !== (input.memo ?? "") || (row.imported_id ?? null) !== importedId ||
      transaction.kind !== input.kind || row.is_parent || row.subtransactions?.length || row.is_child || row.parent_id || row.transfer_id) {
      throw new ActualBrowserUnavailableError("invalid_data");
    }
    return transaction;
  };

  const transferInputSchema = z.object({
    amountYen: z.number().int().safe().positive(),
    date: dateSchema,
    sourceAccountId: idSchema,
    destinationAccountId: idSchema,
    memo: z.string().max(2000).nullable(),
    importedId: z.string().min(1).max(200),
  }).strict();
  const transferUpdateInputSchema = transferInputSchema.omit({ importedId: true });

  const validateTransferAccounts = async (api: ActualApi, sourceAccountId: string, destinationAccountId: string) => {
    if (sourceAccountId === destinationAccountId) throw new ActualMasterValidationError("移動元と移動先には異なる口座を選んでください。");
    const accounts = await api.getAccounts();
    if (!accounts.some(account => account.id === sourceAccountId && !account.closed) ||
        !accounts.some(account => account.id === destinationAccountId && !account.closed)) {
      throw new ActualMasterValidationError("利用中の口座を選び直してください。");
    }
    const payees = await api.getPayees() as Array<{ id: string; name: string; transfer_acct?: string | null }>;
    const destinationPayee = payees.find(payee => payee.transfer_acct === destinationAccountId);
    const sourcePayee = payees.find(payee => payee.transfer_acct === sourceAccountId);
    if (!destinationPayee || !sourcePayee) throw new ActualBrowserUnavailableError("invalid_data");
    return { destinationPayee, sourcePayee, payees };
  };

  const verifyTransferPair = async (
    rows: NativeTransaction[], input: Omit<TransferInput, "importedId"> & { importedId: string | null },
    api: ActualApi,
  ): Promise<ActualTransaction> => {
    const source = rows.find(row => row.imported_id === input.importedId && row.account === input.sourceAccountId);
    const peer = source?.transfer_id ? rows.find(row => row.id === source.transfer_id) : undefined;
    const amount = input.amountYen;
    if (!source || rows.filter(row => row.imported_id === input.importedId).length !== 1 || !peer || source.account !== input.sourceAccountId || peer.account !== input.destinationAccountId ||
      source.transfer_id !== peer.id || peer.transfer_id !== source.id || source.amount !== -amount || peer.amount !== amount ||
      source.date !== input.date || peer.date !== input.date || (source.notes ?? "") !== (input.memo ?? "") || (peer.notes ?? "") !== (input.memo ?? "") ||
      (source.imported_id ?? null) !== input.importedId || source.category || peer.category || source.is_parent || peer.is_parent ||
      source.is_child || peer.is_child || source.parent_id || peer.parent_id || source.subtransactions?.length || peer.subtransactions?.length) {
      throw new ActualBrowserUnavailableError("invalid_data");
    }
    return mapTransaction(source, await namesFor(api), peer.account);
  };


  function scalarSnapshot(row: NativeTransaction): NativeTransactionSnapshot {
    const data = { ...row } as Record<string, unknown>;
    delete data.subtransactions;
    // The API also returns read-only fields; persist only known native scalar fields.
    return nativeTransactionSnapshotSchema.strip().parse(data);
  }
  function validateTree(value: unknown): NativeTransactionSnapshot[] {
    const parsed = z.array(nativeTransactionSnapshotSchema).min(1).max(102).safeParse(value);
    if (!parsed.success) throw new ActualMasterValidationError("削除する取引の構造を確認できませんでした。");
    const tree = parsed.data;
    if (new Set(tree.map(row => row.id)).size !== tree.length) throw new ActualMasterValidationError("取引IDが重複しています。");
    const root = tree[0];
    if (root.is_child || root.parent_id) throw new ActualMasterValidationError("品目だけを削除することはできません。");
    if (root.transfer_id) {
      const peer = tree.find(row => row.id === root.transfer_id);
      if (tree.length !== 2 || !peer || peer.transfer_id !== root.id || peer.account === root.account || peer.amount !== -root.amount || root.is_parent || peer.is_parent || peer.is_child || peer.parent_id) throw new ActualMasterValidationError("振替の両取引を確認できませんでした。");
    } else if (root.is_parent) {
      const children = tree.slice(1);
      const sum = children.reduce((total, row) => total + row.amount, 0);
      if (!children.length || children.some(row => row.parent_id !== root.id || !row.is_child || row.is_parent || row.transfer_id || row.account !== root.account || row.date !== root.date) || !Number.isSafeInteger(sum) || sum !== root.amount) throw new ActualMasterValidationError("分割取引の構造を確認できませんでした。");
    } else if (tree.length !== 1) throw new ActualMasterValidationError("削除する取引を読み込み直してください。");
    return tree;
  }
  function sameNativeSnapshot(row: NativeTransaction, snapshot: NativeTransactionSnapshot): boolean {
    const actual = scalarSnapshot(row);
    // Native API may use null or absent values interchangeably for nullable columns.
    return Object.keys(snapshot).every(key => {
      const field = key as keyof NativeTransactionSnapshot;
      return field === "error" ? JSON.stringify(actual[field] ?? null) === JSON.stringify(snapshot[field] ?? null) : (actual[field] ?? null) === (snapshot[field] ?? null);
    });
  }
  function nativeTree(rows: NativeTransaction[], id: string): NativeTransactionSnapshot[] {
    const selected = rows.find(row => row.id === id);
    if (!selected) return [];
    if (selected.is_child || selected.parent_id) throw new ActualMasterValidationError("品目だけを削除することはできません。");
    const related = selected.transfer_id ? rows.filter(row => row.id === selected.transfer_id) : rows.filter(row => row.parent_id === selected.id);
    return validateTree([selected, ...related].map(scalarSnapshot));
  }
  const masterName = (name: string) => {
    const parsed = z.string().trim().min(1).max(100).safeParse(name);
    if (!parsed.success) throw new ActualMasterValidationError("名前を1〜100文字で入力してください。");
    return parsed.data;
  };
  const masterId = (id: string) => {
    if (!idSchema.safeParse(id).success) throw new ActualMasterValidationError("管理対象を選び直してください。");
    return id;
  };
  const requireCategory = async (api: ActualApi, id: string) => {
    const category = (await api.getCategories()).find(c => c.id === id);
    if (!category) throw new ActualMasterValidationError("カテゴリが見つかりません。一覧を開き直してください。");
    return category;
  };
  const requireAccount = async (api: ActualApi, id: string) => {
    const account = (await api.getAccounts()).find(a => a.id === id);
    if (!account) throw new ActualMasterValidationError("支払元が見つかりません。一覧を開き直してください。");
    return account;
  };
  const categoryUsage = async (api: ActualApi, id: string) => {
    await requireCategory(api, id);
    return (await allRows(api, "0001-01-01", "9999-12-31")).filter(row => row.category === id).length;
  };
  const accountUsage = async (api: ActualApi, id: string) => {
    await requireAccount(api, id);
    const [rows, balanceYen] = await Promise.all([
      api.getTransactions(id, "0001-01-01", "9999-12-31"), api.getAccountBalance(id),
    ]);
    if (!Number.isSafeInteger(balanceYen)) throw new ActualBrowserUnavailableError("invalid_data");
    return { transactionCount: rows.length, balanceYen };
  };

  return {
    async exportBackup(): Promise<Uint8Array> {
      return withBudget(async (api) => new Uint8Array(await api.exportBudget()));
    },

    async restoreBackup(data: Uint8Array, dataDir: string): Promise<string> {
      if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > 500 * 1024 * 1024) {
        throw new Error("Invalid Actual backup.");
      }
      assertDataDir(dataDir);
      const api = await getApi();
      const runtime = runtimeFor(api);
      const run = async () => {
        const previousDataDir = dataDirFor();
        let importStarted = false;
        let importResolved = false;
        let failure: Error | undefined;
        try {
          await activateDataDir(api, runtime, dataDir);
          const before = await localBudgets(api);
          if (before.length > 0) throw new ActualRestoreTargetExistsError();
          importStarted = true;
          const imported = await api.importBudget(data, { type: "actual", filename: "kakeimatch-backup.zip" });
          importResolved = true;
          runtime.loadedBudgetId = imported.id;
          const found = (await localBudgets(api)).find((budget) => budget.id === imported.id);
          if (!found) throw new ActualBrowserUnavailableError("invalid_data");
          await Promise.all([api.getAccounts(), api.getCategories()]);
          return imported.id;
        } catch (error) {
          if (importStarted) {
            try {
              await cleanupDataDir(api, runtime, dataDir);
            } catch (cleanupError) {
              failure = new ActualRestoreIncompleteError(cleanupError);
              throw failure;
            }
            if (!importResolved) {
              failure = new ActualRestoreIncompleteError(error);
              throw failure;
            }
          }
          failure = error instanceof ActualRestoreTargetExistsError || error instanceof ActualBrowserUnavailableError
            ? error : new ActualBrowserUnavailableError("invalid_data");
          throw failure;
        } finally {
          try {
            if (runtime.dataDir !== previousDataDir) await activateDataDir(api, runtime, previousDataDir);
          } catch (reactivationError) {
            // The coordinator relies on these error types to protect occupied targets
            // and remember an import that may have left unenumerable data.
            if (failure) {
              failure.cause = new AggregateError([failure.cause, reactivationError], "Actual restore and previous-directory reactivation failed.");
              throw failure;
            }
            throw reactivationError;
          }
        }
      };
      const result = runtime.tail.then(run, run);
      runtime.tail = result.then(() => undefined, () => undefined);
      return result;
    },

    async deleteLocalBudget(id: string): Promise<void> {
      const parsed = idSchema.safeParse(id);
      if (!parsed.success) throw new Error("Invalid Actual budget ID.");
      return withApi(async (api, runtime) => {
        if (!(await localBudgets(api)).some((budget) => budget.id === parsed.data)) {
          throw new ActualBrowserUnavailableError("storage");
        }
        const send = runtime.send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        if (runtime.loadedBudgetId === parsed.data) {
          const result = await send("close-budget");
          if (result !== "ok") throw new ActualBrowserUnavailableError("operation");
          runtime.loadedBudgetId = undefined;
        }
        const result = await send("delete-budget", { id: parsed.data });
        if (result !== "ok") throw new ActualBrowserUnavailableError("operation");
      });
    },

    async listLocalBudgets(): Promise<Array<{ id: string; name: string }>> {
      return withApi(localBudgets);
    },

    async discardDataDirectory(dataDir: string): Promise<void> {
      assertDataDir(dataDir);
      const api = await getApi();
      const runtime = runtimeFor(api);
      const run = async () => {
        const previousDataDir = dataDirFor();
        try {
          await activateDataDir(api, runtime, dataDir);
          await cleanupDataDir(api, runtime, dataDir);
        } finally {
          if (runtime.dataDir !== previousDataDir) await activateDataDir(api, runtime, previousDataDir);
        }
      };
      const result = runtime.tail.then(run, run);
      runtime.tail = result.then(() => undefined, () => undefined);
      return result;
    },

    getRecentTransactions({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid transaction limit.");
      return withBudget(async (api) => {
        const months = (await api.getBudgetMonths()).toSorted();
        if (months.length === 0) return [];
        const rows = visibleRows(await allRows(api, `${months[0]}-01`, "9999-12-31"));
        rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        const names = await namesFor(api);
        return rows.slice(0, limit).map(row => mapTransaction(row, names, row.transfer_id ? rows.find(peer => peer.id === row.transfer_id)?.account ?? null : null));
      });
    },

    getTransactions({ startDate, endDate }) {
      const start = validateDate(startDate);
      const end = validateDate(endDate);
      if (start > end) throw new Error("Start date must not follow end date.");
      return withBudget(async (api) => {
        const [rows, names] = await Promise.all([allRows(api, start, end), namesFor(api)]);
        return visibleRows(rows).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
          .map((row) => mapTransaction(row, names, row.transfer_id ? rows.find(peer => peer.id === row.transfer_id)?.account ?? null : null));
      });
    },

    getTransactionById(id) {
      const parsedId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(id);
      if (!parsedId.success) return Promise.resolve(null);
      return withBudget(async (api) => {
        const months = (await api.getBudgetMonths()).toSorted();
        if (months.length === 0) return null;
        const rows = await allRows(api, `${months[0]}-01`, "9999-12-31");
        const row = rows.find((transaction) => transaction.id === parsedId.data && !transaction.is_child && !transaction.parent_id);
        return row ? mapTransaction(row, await namesFor(api), row.transfer_id ? rows.find(peer => peer.id === row.transfer_id)?.account ?? null : null) : null;
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
    listIncomeCategories() { return withBudget(listIncomeCategories); },

    createTransaction(input) {
      const parsed = validateManualInput(input, true) as ManualTransactionInput & { memo: string };
      if (parsed.importedId.startsWith("kakeimatch:receipt:")) {
        throw new ActualMasterValidationError("この識別子はレシート登録に使われています。取引を作成し直してください。");
      }
      return withBudget(async api => {
        let rows = await allRows(api, "0001-01-01", "9999-12-31");
        const existing = rows.find(row => row.imported_id === parsed.importedId && !row.is_child && !row.parent_id);
        if (existing) return verifyManualReadback(existing, parsed, parsed.importedId, api);
        await validateManualMasters(api, parsed);
        const amount = parsed.kind === "expense" ? -parsed.amountYen : parsed.amountYen;
        const result = await api.importTransactions(parsed.accountId, [{
          account: parsed.accountId,
          date: parsed.date,
          amount,
          payee_name: parsed.payeeName,
          category: parsed.categoryId,
          notes: parsed.memo,
          imported_id: parsed.importedId,
          cleared: false,
        }]);
        if (result.errors.length > 0) throw new ActualBrowserUnavailableError("invalid_data");
        rows = await allRows(api, "0001-01-01", "9999-12-31");
        const saved = rows.find(row => row.imported_id === parsed.importedId && !row.is_child && !row.parent_id);
        return verifyManualReadback(saved, parsed, parsed.importedId, api);
      });
    },

    updateTransaction(id, input) {
      const parsedId = idSchema.safeParse(id);
      const parsed = validateManualInput(input, false) as Omit<ManualTransactionInput, "importedId"> & { memo: string };
      if (!parsedId.success) throw new ActualMasterValidationError("編集する取引を読み込み直してください。");
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const current = rows.find(row => row.id === parsedId.data);
        if (!current || current.is_parent || current.is_child || current.parent_id || current.subtransactions?.length || current.transfer_id) {
          throw new ActualMasterValidationError("この取引は編集できません。");
        }
        if (current.imported_id?.startsWith("kakeimatch:receipt:")) {
          throw new ActualMasterValidationError("レシートに登録した取引はここから編集できません。");
        }
        const currentKind = current.amount < 0 ? "expense" : current.amount > 0 ? "income" : null;
        if (currentKind !== parsed.kind) throw new ActualMasterValidationError("取引の種類は変更できません。");
        await validateManualMasters(api, parsed);
        const payees = await api.getPayees();
        const matchingPayee = payees.find(payee => normalizeMerchant(payee.name) === normalizeMerchant(parsed.payeeName));
        const payeeId = matchingPayee?.id ?? await api.createPayee({ name: parsed.payeeName });
        const amount = parsed.kind === "expense" ? -parsed.amountYen : parsed.amountYen;
        const send = runtimeFor(api).send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        await send("transactions-batch-update", { updated: [{
          id: parsedId.data,
          account: parsed.accountId,
          date: parsed.date,
          amount,
          payee: payeeId,
          category: parsed.categoryId,
          notes: parsed.memo,
          cleared: current.cleared ?? false,
          imported_id: current.imported_id ?? undefined,
          reconciled: current.reconciled,
        }], runTransfers: false });
        const movedRows = await allRows(api, parsed.date, parsed.date);
        const saved = movedRows.find(row => row.id === parsedId.data);
        return verifyManualReadback(saved, parsed, current.imported_id ?? null, api);
      });
    },

    createTransfer(input) {
      const parsed = transferInputSchema.safeParse({ ...input, memo: input?.memo ?? null });
      if (!parsed.success) throw new ActualMasterValidationError("振替内容を確認して入力し直してください。");
      if (parsed.data.importedId.startsWith("kakeimatch:receipt:") || parsed.data.importedId.startsWith("kakeimatch:manual:")) {
        throw new ActualMasterValidationError("この識別子は別の記録に使われています。振替を作成し直してください。");
      }
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const existing = rows.find(row => row.imported_id === parsed.data.importedId);
        if (existing) {
          if (!existing.transfer_id || rows.filter(row => row.imported_id === parsed.data.importedId).length !== 1) {
            throw new ActualMasterValidationError("この識別子は別の記録に使われています。振替を作成し直してください。");
          }
          return verifyTransferPair(rows, parsed.data, api);
        }
        const { destinationPayee } = await validateTransferAccounts(api, parsed.data.sourceAccountId, parsed.data.destinationAccountId);
        await api.addTransactions(parsed.data.sourceAccountId, [{
          date: parsed.data.date,
          amount: -parsed.data.amountYen,
          payee: destinationPayee.id,
          notes: parsed.data.memo ?? "",
          imported_id: parsed.data.importedId,
          cleared: false,
        }], { runTransfers: true });
        const savedRows = await allRows(api, "0001-01-01", "9999-12-31");
        return verifyTransferPair(savedRows, parsed.data, api);
      });
    },

    updateTransfer(id, input) {
      const parsedId = idSchema.safeParse(id);
      const parsed = transferUpdateInputSchema.safeParse({ ...input, memo: input?.memo ?? null });
      if (!parsedId.success || !parsed.success) throw new ActualMasterValidationError("編集する振替を確認して入力し直してください。");
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const selected = rows.find(row => row.id === parsedId.data);
        const selectedPeer = selected?.transfer_id ? rows.find(row => row.id === selected.transfer_id) : undefined;
        const current = selected?.imported_id ? selected : selectedPeer?.imported_id ? selectedPeer : undefined;
        const peer = current?.transfer_id ? rows.find(row => row.id === current.transfer_id) : undefined;
        if (!current || !peer || peer.transfer_id !== current.id || current.account === peer.account || current.category || peer.category || current.is_parent || peer.is_parent || current.is_child || peer.is_child || current.parent_id || peer.parent_id || current.subtransactions?.length || peer.subtransactions?.length || current.imported_id?.startsWith("kakeimatch:receipt:")) {
          throw new ActualMasterValidationError("編集する振替が見つかりません。記録を読み込み直してください。");
        }
        const importedId = current.imported_id ?? null;
        if (!importedId) throw new ActualMasterValidationError("識別情報のない振替は編集できません。");
        const { destinationPayee, sourcePayee } = await validateTransferAccounts(api, parsed.data.sourceAccountId, parsed.data.destinationAccountId);
        const send = runtimeFor(api).send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        // The public updateTransaction wrapper does not await transfer post-processing in
        // Actual 26.9.0. Apply both complete sides in one native batch with transfer hooks
        // disabled, preserving the existing reciprocal IDs and avoiding a partial edit.
        await send("transactions-batch-update", {
          updated: [
            {
              id: current.id,
              account: parsed.data.sourceAccountId,
              date: parsed.data.date,
              amount: -parsed.data.amountYen,
              payee: destinationPayee.id,
              notes: parsed.data.memo ?? "",
              transfer_id: peer.id,
            },
            {
              id: peer.id,
              account: parsed.data.destinationAccountId,
              date: parsed.data.date,
              amount: parsed.data.amountYen,
              payee: sourcePayee.id,
              notes: parsed.data.memo ?? "",
              transfer_id: current.id,
            },
          ],
          runTransfers: false,
        });
        const savedRows = await allRows(api, "0001-01-01", "9999-12-31");
        return verifyTransferPair(savedRows, { ...parsed.data, importedId }, api);
      });
    },

    listCategories() {
      return withBudget(async api => {
        const [categories, groups] = await Promise.all([api.getCategories(), api.getCategoryGroups()]);
        return categories.map(c => ({ id: c.id, name: c.name, isIncome: Boolean(c.is_income),
          hidden: Boolean(c.hidden || groups.find(g => g.id === c.group_id)?.hidden),
          groupName: groups.find(g => g.id === c.group_id)?.name ?? "" }));
      });
    },

    addCategory(name, isIncome) {
      const validName = masterName(name);
      if (typeof isIncome !== "boolean") throw new ActualMasterValidationError("収入か支出を選んでください。");
      return withBudget(async api => {
        const groups = await api.getCategoryGroups();
        const group = groups.find(g => Boolean(g.is_income) === isIncome && !g.hidden);
        const groupId = group?.id ?? await api.createCategoryGroup({ name: isIncome ? "収入" : "支出", is_income: isIncome });
        return api.createCategory({ name: validName, group_id: groupId, is_income: isIncome, hidden: false });
      });
    },

    setCategoryHidden(id, hidden) {
      masterId(id);
      if (typeof hidden !== "boolean") throw new ActualMasterValidationError("表示状態を選び直してください。");
      return withBudget(async api => { const category = await requireCategory(api, id); await api.updateCategory(id, { name: category.name, hidden }); });
    },

    getCategoryUsage(id) { masterId(id); return withBudget(api => categoryUsage(api, id)); },

    deleteCategory(id) {
      masterId(id);
      return withBudget(async api => {
        if (await categoryUsage(api, id)) throw new ActualMasterValidationError("既存の取引で使われているカテゴリは削除できません。利用をやめる場合は非表示にしてください。");
        await api.deleteCategory(id);
      });
    },

    listAccounts() { return withBudget(async api => (await api.getAccounts()).map(a => ({ id: a.id, name: a.name, closed: Boolean(a.closed) }))); },
    addAccount(name) {
      const validName = masterName(name);
      return withBudget(api => api.createAccount({ name: validName, offbudget: false, closed: false }));
    },
    renameAccount(id, name) {
      masterId(id); const validName = masterName(name);
      return withBudget(async api => { await requireAccount(api, id); await api.updateAccount(id, { name: validName }); });
    },
    getAccountUsage(id) { masterId(id); return withBudget(api => accountUsage(api, id)); },
    closeAccount(id) {
      masterId(id);
      return withBudget(async api => {
        const usage = await accountUsage(api, id);
        if (usage.balanceYen !== 0) throw new ActualMasterValidationError("残高がある支払元は利用終了にできません。残高を移動して0円にしてから再度お試しください。");
        // Actual's closeAccount deletes accounts with no transactions. Keep them reopenable.
        if (usage.transactionCount === 0) await api.updateAccount(id, { closed: true });
        else await api.closeAccount(id);
      });
    },
    reopenAccount(id) {
      masterId(id);
      return withBudget(async api => { await requireAccount(api, id); await api.reopenAccount(id); });
    },
    deleteAccount(id) {
      masterId(id);
      return withBudget(async api => {
        const usage = await accountUsage(api, id);
        if (usage.transactionCount || usage.balanceYen !== 0) throw new ActualMasterValidationError("取引または残高がある支払元は完全削除できません。履歴を残すため、利用終了を選んでください。");
        await api.deleteAccount(id);
      });
    },

    createExpenseCategory(name, groupId) {
      const parsed = z.object({ name: z.string().trim().min(1).max(100), groupId: idSchema }).safeParse({ name, groupId });
      if (!parsed.success) throw new Error("Invalid Actual category.");
      return withBudget((api) => api.createCategory({ name: parsed.data.name, group_id: parsed.data.groupId, is_income: false, hidden: false }));
    },

    renameCategory(id, name) {
      const parsed = z.object({ id: idSchema, name: z.string().trim().min(1).max(100) }).safeParse({ id, name });
      if (!parsed.success) throw new ActualMasterValidationError("カテゴリ名を1〜100文字で入力してください。");
      return withBudget(async (api) => { await requireCategory(api, parsed.data.id); await api.updateCategory(parsed.data.id, { name: parsed.data.name }); });
    },

    async importReceipt(input) {
      const parsed = z.object({
        accountId: idSchema,
        date: dateSchema,
        amountYen: z.number().int().safe().negative(),
        merchant: z.string().trim().min(1).max(200),
        categoryId: idSchema,
        importedId: z.string().min(1).max(200),
        splits: z.array(z.object({ categoryId: idSchema, amountYen: z.number().int().safe().negative() })).min(1).optional(),
      }).safeParse(input);
      if (!parsed.success || (parsed.data.splits && parsed.data.splits.reduce((sum, split) => sum + split.amountYen, 0) !== parsed.data.amountYen)) throw new Error("Invalid Actual receipt transaction.");
      return withBudget(async (api) => {
        const accounts = await api.getAccounts();
        if (!accounts.some((account) => account.id === parsed.data.accountId && !account.closed)) {
          throw new ActualMasterValidationError("利用中の支払元を選び直してください。");
        }
        const allowedCategories = new Set((await listCategories(api)).map(c => c.id));
        if (!parsed.data.splits && !allowedCategories.has(parsed.data.categoryId)) throw new ActualMasterValidationError("支出カテゴリを選び直してください。");
        if (parsed.data.splits?.some(split => !allowedCategories.has(split.categoryId))) throw new ActualMasterValidationError("支出カテゴリを選び直してください。");
        const result = await api.importTransactions(parsed.data.accountId, [{
          account: parsed.data.accountId,
          date: parsed.data.date,
          amount: parsed.data.amountYen,
          payee_name: parsed.data.merchant,
          category: parsed.data.categoryId,
          imported_id: parsed.data.importedId,
          cleared: false,
          ...(parsed.data.splits ? { subtransactions: parsed.data.splits.map(split => ({ amount: split.amountYen, category: split.categoryId })) } : {}),
        }]);
        if (result.errors.length > 0) throw new ActualBrowserUnavailableError("invalid_data");
        const rows = await api.getTransactions(parsed.data.accountId, parsed.data.date, parsed.data.date) as NativeTransaction[];
        const saved = rows.find((row) => row.imported_id === parsed.data.importedId && Boolean(row.is_parent) === Boolean(parsed.data.splits));
        if (!saved) throw new ActualBrowserUnavailableError("invalid_data");
        const transaction = mapTransaction(saved, await namesFor(api));
        if (saved.account !== parsed.data.accountId || saved.date !== parsed.data.date ||
          transaction.amountYen !== parsed.data.amountYen || normalizeMerchant(transaction.payeeName ?? "") !== normalizeMerchant(parsed.data.merchant) ||
          (parsed.data.splits ? !sameSplitSet(readBackSplitSet(saved, rows), parsed.data.splits) : saved.category !== parsed.data.categoryId) || transaction.kind !== "expense") {
          throw new ActualBrowserUnavailableError("invalid_data");
        }
        return transaction;
      });
    },

    async editReceipt(id, input) {
      const parsed = z.object({
        id: idSchema,
        accountId: idSchema,
        date: dateSchema,
        amountYen: z.number().int().safe().negative(),
        merchant: z.string().trim().min(1).max(200),
        categoryId: idSchema,
        importedId: z.string().min(1).max(200).startsWith("kakeimatch:receipt:"),
        splits: z.array(z.object({ categoryId: idSchema, amountYen: z.number().int().safe().negative() })).min(1).optional(),
      }).strict().safeParse({ id, ...input });
      if (!parsed.success || (parsed.data.splits && parsed.data.splits.reduce((sum, split) => sum + split.amountYen, 0) !== parsed.data.amountYen)) {
        throw new Error("Invalid Actual receipt transaction.");
      }
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const current = rows.find(row => row.id === parsed.data.id);
        if (!current || current.imported_id !== parsed.data.importedId || current.is_child || current.parent_id || current.transfer_id ||
          current.imported_id?.startsWith("kakeimatch:receipt:") !== true) {
          throw new ActualMasterValidationError("編集するレシート取引が見つかりません。記録を読み込み直してください。");
        }
        const children = rows.filter(row => row.parent_id === current.id);
        if (Boolean(current.is_parent) !== Boolean(children.length) || (current.is_parent && !children.length)) {
          throw new ActualBrowserUnavailableError("invalid_data");
        }
        const [accounts, availableCategories, payees] = await Promise.all([api.getAccounts(), listCategories(api), api.getPayees()]);
        if (!accounts.some(account => account.id === parsed.data.accountId && !account.closed)) {
          throw new ActualMasterValidationError("利用中の支払元を選び直してください。");
        }
        const categoryIds = new Set(availableCategories.map(category => category.id));
        if ((!parsed.data.splits && !categoryIds.has(parsed.data.categoryId)) || parsed.data.splits?.some(split => !categoryIds.has(split.categoryId))) {
          throw new ActualMasterValidationError("支出カテゴリを選び直してください。");
        }
        const send = runtimeFor(api).send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        const currentNames = await namesFor(api);
        const currentTransaction = mapTransaction(current, currentNames);
        const alreadyMatches = current.account === parsed.data.accountId && current.date === parsed.data.date && current.amount === parsed.data.amountYen &&
          normalizeMerchant(currentTransaction.payeeName ?? "") === normalizeMerchant(parsed.data.merchant) && current.imported_id === parsed.data.importedId &&
          (parsed.data.splits
            ? Boolean(current.is_parent) && sameSplitSet(readBackSplitSet(current, rows), parsed.data.splits)
            : !current.is_parent && !children.length && current.category === parsed.data.categoryId);
        if (alreadyMatches) return currentTransaction;
        const payeeId = payees.find(payee => payee.name === parsed.data.merchant)?.id ?? await api.createPayee({ name: parsed.data.merchant });
        const shared: Pick<ActualBatchTransaction, "account" | "date" | "amount" | "payee" | "notes" | "imported_id" | "cleared" | "reconciled"> = {
          account: parsed.data.accountId,
          date: parsed.data.date,
          amount: parsed.data.amountYen,
          payee: payeeId,
          notes: current.notes ?? "",
          imported_id: current.imported_id,
          cleared: current.cleared ?? false,
          reconciled: current.reconciled,
        };
        let updated: ActualBatchTransaction[];
        let added: ActualBatchTransaction[] = [];
        let deleted: Array<{ id: string }> = [];
        if (parsed.data.splits) {
          const desiredChildren: ActualBatchTransaction[] = parsed.data.splits.map((split, index) => ({
            id: children[index]?.id ?? crypto.randomUUID(),
            parent_id: current.id,
            is_child: true,
            account: parsed.data.accountId,
            date: parsed.data.date,
            amount: split.amountYen,
            category: split.categoryId,
            payee: payeeId,
            cleared: current.cleared ?? false,
            reconciled: current.reconciled,
            sort_order: children[index]?.sort_order ?? -(index + 1),
          }));
          const parent: ActualBatchTransaction = {
            id: current.id, ...shared, category: null, is_parent: true, is_child: false,
          };
          updated = [parent, ...desiredChildren.filter(child => children.some(existing => existing.id === child.id))];
          added = desiredChildren.filter(child => !children.some(existing => existing.id === child.id));
          deleted = children.slice(desiredChildren.length).map(child => ({ id: child.id }));
        } else {
          updated = [{ id: current.id, ...shared, category: parsed.data.categoryId, is_parent: false, is_child: false }];
          deleted = children.map(child => ({ id: child.id }));
        }
        const nativeSend = send as unknown as (method: string, args: unknown) => Promise<unknown>;
        await nativeSend("transactions-batch-update", { updated, added, deleted, runTransfers: false });
        const savedRows = await allRows(api, "0001-01-01", "9999-12-31");
        const saved = savedRows.find(row => row.id === current.id);
        if (!saved) throw new ActualBrowserUnavailableError("invalid_data");
        const transaction = mapTransaction(saved, await namesFor(api));
        const savedChildren = savedRows.filter(row => row.parent_id === saved.id);
        if (saved.account !== parsed.data.accountId || saved.date !== parsed.data.date || saved.amount !== parsed.data.amountYen ||
          normalizeMerchant(transaction.payeeName ?? "") !== normalizeMerchant(parsed.data.merchant) || saved.imported_id !== parsed.data.importedId ||
          (saved.cleared ?? false) !== (current.cleared ?? false) || (saved.notes ?? "") !== (current.notes ?? "") ||
          Boolean(saved.is_parent) !== Boolean(parsed.data.splits) || (parsed.data.splits
            ? !sameSplitSet(readBackSplitSet(saved, savedRows), parsed.data.splits)
            : saved.category !== parsed.data.categoryId || savedChildren.length > 0)) {
          throw new ActualBrowserUnavailableError("invalid_data");
        }
        return transaction;
      });
    },


    getTransactionTree(id) {
      masterId(id);
      return withBudget(async api => nativeTree(await allRows(api, "0001-01-01", "9999-12-31"), id));
    },
    async deleteTransactionTree(input) {
      const snapshot = validateTree(input);
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const ids = new Set(snapshot.map(row => row.id));
        const current = rows.filter(row => ids.has(row.id));
        if (!current.length) return;
        const tree = nativeTree(rows, snapshot[0].id);
        if (tree.length !== snapshot.length || current.length !== snapshot.length || tree.some(row => !ids.has(row.id)) || current.some(row => !sameNativeSnapshot(row, snapshot.find(saved => saved.id === row.id)!))) throw new ActualMasterValidationError("取引が変更されています。最新の内容を確認してください。");
        const send = runtimeFor(api).send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        await send("transactions-batch-update", { deleted: snapshot.map(row => ({ id: row.id })), runTransfers: false });
        if ((await allRows(api, "0001-01-01", "9999-12-31")).some(row => ids.has(row.id))) throw new ActualBrowserUnavailableError("invalid_data");
      });
    },
    async restoreTransactionTree(input) {
      const snapshot = validateTree(input);
      return withBudget(async api => {
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        const ids = new Set(snapshot.map(row => row.id));
        const existing = rows.filter(row => ids.has(row.id));
        if (existing.length) {
          if (existing.length === snapshot.length && existing.every(row => sameNativeSnapshot(row, snapshot.find(saved => saved.id === row.id)!))) return;
          throw new ActualMasterValidationError("同じ識別子の取引が変更されています。取り消しを完了できません。");
        }
        if (snapshot.some(saved => saved.imported_id && rows.some(row => row.imported_id === saved.imported_id))) throw new ActualMasterValidationError("同じ登録識別子の取引があります。取り消しを完了できません。");
        const [accounts, categories, payees] = await Promise.all([api.getAccounts(), api.getCategories(), api.getPayees()]);
        if (snapshot.some(row => !accounts.some(account => account.id === row.account) || row.category && !categories.some(category => category.id === row.category) || row.payee && !payees.some(payee => payee.id === row.payee))) throw new ActualMasterValidationError("元の口座やカテゴリを確認できません。取り消しを完了できません。");
        const send = runtimeFor(api).send;
        if (!send) throw new ActualBrowserUnavailableError("storage");
        // Actual deletes by setting tombstone; a native update can restore the same IDs.
        const nativeSend = send as unknown as (method: "transactions-batch-update", args: { updated: Array<NativeTransactionSnapshot & { tombstone: false }>; runTransfers: false }) => Promise<unknown>;
        await nativeSend("transactions-batch-update", { updated: snapshot.map(row => ({ ...row, tombstone: false })), runTransfers: false });
        const restored = await allRows(api, "0001-01-01", "9999-12-31");
        const tree = nativeTree(restored, snapshot[0].id);
        if (tree.length !== snapshot.length || tree.some(row => !ids.has(row.id)) || snapshot.some(saved => !sameNativeSnapshot(restored.find(row => row.id === saved.id)!, saved))) throw new ActualBrowserUnavailableError("invalid_data");
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
        const rows = await allRows(api, "0001-01-01", "9999-12-31");
        for (const update of parsed.data) {
          if (update.amountYen === undefined) continue;
          const row = rows.find(transaction => transaction.id === update.transactionId);
          if (!row) throw new ActualMasterValidationError("照合対象の取引が見つかりません。明細を読み込み直してください。");
          const isSplitParent = row.is_parent || Boolean(row.subtransactions?.length) || rows.some(transaction => transaction.parent_id === row.id);
          if (isSplitParent && update.amountYen !== row.amount) {
            throw new ActualMasterValidationError("分割取引の金額差を確認してください。現在はこの金額差を自動反映できません。");
          }
        }
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
