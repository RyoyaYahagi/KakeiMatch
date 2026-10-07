import { categoryKey, type MoneyForwardRow } from "./moneyforward-parser";
import type { NativeTransactionSnapshot } from "../../../src/lib/actual-browser-ledger";
import type { ActualTransaction } from "../../../src/lib/actual-ledger";
import type { LocalDataRepository, LocalDataRecord } from "../../../src/lib/local-data";
import { moneyForwardImportSettingsSchema, moneyForwardRowSchema } from "../../../src/lib/moneyforward-import-format";

export type CategoryChoice =
  | { kind: "existing"; categoryId: string }
  | { kind: "new"; name: string }
  | { kind: "unclassified" }
  | { kind: "exclude" }
  | { kind: "unresolved" };
export type AccountChoice =
  | { kind: "existing"; accountId: string }
  | { kind: "new"; name: string }
  | { kind: "unset" };
export type MoneyForwardImportRules = {
  categories: Record<string, CategoryChoice>;
  accounts: Record<string, AccountChoice>;
};
export type MoneyForwardImportRowStatus = "pending" | "importing" | "created" | "duplicate" | "excluded" | "failed" | "undoing" | "undone";
export type MoneyForwardImportBatch = {
  id: string;
  budgetId: string;
  createdAt: string;
  updatedAt: string;
  status: "planned" | "processing" | "completed" | "partial" | "undoing" | "undone" | "undo-partial";
  mappings: MoneyForwardImportRules;
  rows: Array<{
    row: MoneyForwardRow;
    importedId: string;
    status: MoneyForwardImportRowStatus;
    transactionSnapshot: NativeTransactionSnapshot[] | null;
    error: string | null;
  }>;
};
type StoredState = { version: 1; rules: MoneyForwardImportRules; batches: MoneyForwardImportBatch[] };

type Ledger = {
  listAccounts(): Promise<Array<{ id: string; name: string; closed: boolean }>>;
  listCategories(): Promise<Array<{ id: string; name: string; isIncome: boolean }>>;
  addAccount(name: string, accountType?: "bank" | "credit_card" | "cash" | "other"): Promise<string>;
  addCategory(name: string, isIncome: boolean): Promise<string>;
  listImportedIds(): Promise<Set<string>>;
  getImportedTransaction(importedId: string): Promise<{ transaction: ActualTransaction; snapshot: NativeTransactionSnapshot[] } | null>;
  importExternalTransaction(input: {
    accountId: string; date: string; amountYen: number; kind: "expense" | "income";
    payeeName: string; memo?: string | null; categoryId: string | null; importedId: string;
  }): Promise<{ transaction: ActualTransaction; snapshot: NativeTransactionSnapshot[]; alreadyExisted: boolean }>;
  getTransactionTree(id: string): Promise<NativeTransactionSnapshot[]>;
  deleteTransactionTree(snapshot: NativeTransactionSnapshot[]): Promise<void>;
};
type ImportRepository = Pick<LocalDataRepository, "get" | "put">;
export type ImportPreviewRow = {
  row: MoneyForwardRow;
  importedId: string;
  status: "ready" | "duplicate" | "excluded" | "unresolved";
  accountName: string;
  categoryName: string | null;
};
export type ImportPlan = {
  batchId: string;
  mappings: MoneyForwardImportRules;
  summary: { total: number; ready: number; excluded: number; duplicates: number; unresolved: number };
  previewRows: ImportPreviewRow[];
};

const SETTINGS_ID = "settings:moneyforward-import";
const defaultRules = (): MoneyForwardImportRules => ({ categories: {}, accounts: {} });
const defaultState = (): StoredState => ({ version: 1, rules: defaultRules(), batches: [] });
const clone = <T,>(value: T): T => structuredClone(value);

function importedId(row: MoneyForwardRow): string {
  const result = `moneyforward:${row.sourceKey}`;
  if (result.length > 200) throw new Error(`行 ${row.rowNumber}: 明細識別子が長すぎます。`);
  return result;
}
function defaultStatus(row: MoneyForwardRow, category: CategoryChoice | undefined): ImportPreviewRow["status"] {
  if (row.isTransfer || !row.isIncludedInCalculation || category?.kind === "exclude") return "excluded";
  if (!category || category.kind === "unresolved") return "unresolved";
  return "ready";
}
function choiceName(choice: CategoryChoice | undefined, categories: Array<{ id: string; name: string }>): string | null {
  if (choice?.kind === "existing") return categories.find(row => row.id === choice.categoryId)?.name ?? null;
  if (choice?.kind === "new") return choice.name;
  if (choice?.kind === "unclassified") return "未分類";
  return null;
}

/** Local, resumable Money Forward import with an Actual transaction journal. */
export class MoneyForwardImportService {
  constructor(private readonly repository: ImportRepository, private readonly ledger: Ledger,
    private readonly options: { getBudgetId: () => string | null; withLock?: <T>(name: string, work: () => Promise<T>) => Promise<T>; makeId?: () => string; now?: () => Date } ) {}

  private recordId() { return SETTINGS_ID; }
  private async state(): Promise<StoredState> {
    const record = await this.repository.get<StoredState>(this.recordId());
    if (!record) return defaultState();
    const parsed = moneyForwardImportSettingsSchema.safeParse(record.value);
    if (!parsed.success) {
      throw new Error("Money Forwardの移行履歴を読み取れません。端末データを確認してください。");
    }
    return parsed.data;
  }
  private async save(state: StoredState) {
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    const record: LocalDataRecord<StoredState> = { id: this.recordId(), kind: "app-settings", value: state, updatedAt: timestamp };
    await this.repository.put(record);
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const budgetId = this.options.getBudgetId();
    if (!budgetId) throw new Error("家計簿を選択してから操作してください。");
    const name = "kakeimatch:moneyforward-import";
    if (this.options.withLock) return this.options.withLock(name, work);
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new Error("このブラウザーは複数画面での安全な移行に対応していません。更新後に再度お試しください。");
    return await locks.request(name, { mode: "exclusive" }, async () => await work());
  }
  async getRules(): Promise<MoneyForwardImportRules> { return clone((await this.state()).rules); }
  async saveRules(rules: MoneyForwardImportRules): Promise<void> {
    await this.lock(async () => {
      const state = await this.state();
      const parsed = moneyForwardImportSettingsSchema.safeParse({ version: 1, rules, batches: state.batches });
      if (!parsed.success) throw new Error("Money Forwardの分類ルールを確認してください。");
      state.rules = clone(rules);
      await this.save(state);
    });
  }

  async plan(rows: MoneyForwardRow[], mappings?: Partial<MoneyForwardImportRules>): Promise<ImportPlan> {
    return this.lock(async () => {
      const state = await this.state();
      if (!Array.isArray(rows) || rows.length > 20_000 || rows.some(row => !moneyForwardRowSchema.safeParse(row).success)) {
        throw new Error("Money Forwardの取引データを確認できません。");
      }
      const rules = { categories: { ...state.rules.categories, ...(mappings?.categories ?? {}) }, accounts: { ...state.rules.accounts, ...(mappings?.accounts ?? {}) } };
      if (!moneyForwardImportSettingsSchema.safeParse({ version: 1, rules, batches: [] }).success) throw new Error("Money Forwardの移行設定を確認してください。");
      const [accounts, categories] = await Promise.all([this.ledger.listAccounts(), this.ledger.listCategories()]);
      const importedIds = await this.ledger.listImportedIds();
      const seenFileIds = new Set<string>();
      const previewRows = rows.map(row => {
        const category = rules.categories[categoryKey(row)];
        const sourceAccount = row.accountName ?? "";
        const accountChoice = rules.accounts[sourceAccount] ?? { kind: "unset" as const };
        const status = defaultStatus(row, category);
        const id = importedId(row);
        const duplicate = status !== "excluded" && (importedIds.has(id) || seenFileIds.has(id));
        if (status === "ready") seenFileIds.add(id);
        let accountName = "移行元未設定";
        if (accountChoice.kind === "existing") accountName = accounts.find(account => account.id === accountChoice.accountId)?.name ?? "未解決の口座";
        else if (accountChoice.kind === "new") accountName = accountChoice.name;
        return {
          row, importedId: id,
          status: duplicate ? "duplicate" as const : status,
          accountName,
          categoryName: choiceName(category, categories),
        };
      });
      const batchId = (this.options.makeId ?? (() => crypto.randomUUID()))();
      const timestamp = (this.options.now?.() ?? new Date()).toISOString();
      const batch: MoneyForwardImportBatch = {
        id: batchId, budgetId: this.options.getBudgetId()!, createdAt: timestamp, updatedAt: timestamp, status: "planned", mappings: clone(rules),
        rows: previewRows.map(preview => ({ row: preview.row, importedId: preview.importedId,
          status: preview.status === "excluded" ? "excluded" : preview.status === "duplicate" ? "duplicate" : "pending",
          transactionSnapshot: null, error: null })),
      };
      state.batches = state.batches.filter(existing => existing.status !== "planned");
      if (state.batches.length >= 100) throw new Error("移行履歴が100回に達したため、新しい移行を開始できません。保存済みのデータは保持されています。");
      state.batches.push(batch);
      await this.save(state);
      return { batchId, mappings: clone(rules), summary: {
        total: rows.length,
        ready: previewRows.filter(row => row.status === "ready").length,
        excluded: previewRows.filter(row => row.status === "excluded").length,
        duplicates: previewRows.filter(row => row.status === "duplicate").length,
        unresolved: previewRows.filter(row => row.status === "unresolved").length,
      }, previewRows };
    });
  }

  async getHistory(): Promise<MoneyForwardImportBatch[]> {
    const budgetId = this.options.getBudgetId();
    return clone((await this.state()).batches.filter(batch => batch.budgetId === budgetId && batch.status !== "planned"));
  }

  async updateMappings(batchId: string, mappings: Partial<MoneyForwardImportRules>): Promise<MoneyForwardImportBatch> {
    return this.lock(async () => {
      const state = await this.state();
      const batch = state.batches.find(row => row.id === batchId && row.budgetId === this.options.getBudgetId());
      if (!batch || !["planned", "partial"].includes(batch.status)) throw new Error("この移行バッチの分類は変更できません。");
      const merged = {
        categories: { ...batch.mappings.categories, ...(mappings.categories ?? {}) },
        accounts: { ...batch.mappings.accounts, ...(mappings.accounts ?? {}) },
      };
      if (!moneyForwardImportSettingsSchema.safeParse({ version: 1, rules: merged, batches: [] }).success) throw new Error("Money Forwardの移行設定を確認してください。");
      batch.mappings = merged;
      batch.rows = batch.rows.map(item => item.status === "failed" ? { ...item, status: "pending", error: null } : item);
      batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.save(state);
      return clone(batch);
    });
  }

  private async resolveAccount(sourceName: string, choice: AccountChoice, batch: MoneyForwardImportBatch, state: StoredState): Promise<string> {
    const accounts = await this.ledger.listAccounts();
    if (choice.kind === "existing") {
      const selected = accounts.find(account => account.id === choice.accountId && !account.closed);
      if (!selected) throw new Error("選択した口座が見つかりません。");
      return selected.id;
    }
    const name = choice.kind === "new" ? choice.name.trim() : "移行元未設定";
    const existing = accounts.find(account => !account.closed && account.name === name);
    const accountId = existing?.id ?? await this.ledger.addAccount(name, "other");
    batch.mappings.accounts[sourceName] = { kind: "existing", accountId };
    await this.save(state);
    return accountId;
  }
  private async resolveCategory(row: MoneyForwardRow, choice: CategoryChoice, batch: MoneyForwardImportBatch, state: StoredState): Promise<string | null> {
    if (choice.kind === "unclassified") return null;
    if (choice.kind === "existing") {
      const category = (await this.ledger.listCategories()).find(item => item.id === choice.categoryId);
      if (!category || category.isIncome !== (row.kind === "income")) throw new Error("選択したカテゴリの収支区分が取引と一致しません。");
      return category.id;
    }
    if (choice.kind !== "new") throw new Error("カテゴリを決めてから移行してください。");
    const name = choice.name.trim();
    if (!name) throw new Error("新しいカテゴリ名を入力してください。");
    const categories = await this.ledger.listCategories();
    const existing = categories.find(item => item.name === name && item.isIncome === (row.kind === "income"));
    const categoryId = existing?.id ?? await this.ledger.addCategory(name, row.kind === "income");
    batch.mappings.categories[categoryKey(row)] = { kind: "existing", categoryId };
    await this.save(state);
    return categoryId;
  }

  async confirm(batchId: string): Promise<MoneyForwardImportBatch> {
    return this.lock(async () => {
      const budgetId = this.options.getBudgetId();
      const state = await this.state();
      const batch = state.batches.find(row => row.id === batchId);
      if (!batch || batch.budgetId !== budgetId) throw new Error("移行バッチが見つからないか、別の家計簿の履歴です。");
      if (batch.status === "undone" || batch.status === "undoing" || batch.status === "undo-partial") throw new Error("取り消し中または取り消し済みのバッチは確定できません。");
      const unresolved = batch.rows.some(item => item.status === "pending" && defaultStatus(item.row, batch.mappings.categories[categoryKey(item.row)]) === "unresolved");
      if (unresolved) throw new Error("未解決のカテゴリがあります。カテゴリを選んでから確定してください。");
      batch.status = "processing";
      batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.save(state);
      const importedIds = await this.ledger.listImportedIds();
      const seenFileIds = new Set<string>();
      for (const item of batch.rows) {
        if (defaultStatus(item.row, batch.mappings.categories[categoryKey(item.row)]) !== "ready") continue;
        if (seenFileIds.has(item.importedId)) { item.status = "duplicate"; continue; }
        seenFileIds.add(item.importedId);
        if (["pending", "failed", "duplicate"].includes(item.status)) {
          item.status = importedIds.has(item.importedId) ? "duplicate" : "pending";
        }
      }
      for (const item of batch.rows) {
        if (item.status !== "pending" && item.status !== "failed" && item.status !== "importing") continue;
        const previewStatus = defaultStatus(item.row, batch.mappings.categories[categoryKey(item.row)]);
        if (previewStatus === "excluded") { item.status = "excluded"; continue; }
        const wasRecovering = item.status === "importing";
        try {
          const sourceAccount = item.row.accountName ?? "";
          const accountChoice = batch.mappings.accounts[sourceAccount] ?? { kind: "unset" as const };
          const categoryChoice = batch.mappings.categories[categoryKey(item.row)];
          if (!categoryChoice || categoryChoice.kind === "unresolved" || categoryChoice.kind === "exclude") throw new Error("カテゴリを決めてから移行してください。");
          const accountId = await this.resolveAccount(sourceAccount, accountChoice, batch, state);
          const categoryId = await this.resolveCategory(item.row, categoryChoice, batch, state);
          // Persist intent before the Actual write so the next attempt can recover an interrupted row.
          item.status = "importing";
          item.error = null;
          batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
          await this.save(state);
          const result = await this.ledger.importExternalTransaction({
            accountId, date: item.row.date, amountYen: Math.abs(item.row.amountYen), kind: item.row.kind,
            payeeName: item.row.description.trim() || "Money Forwardの明細", memo: item.row.memo,
            categoryId, importedId: item.importedId,
          });
          const matchingRecovered = wasRecovering && result.alreadyExisted
            && result.transaction.accountId === accountId && result.transaction.date === item.row.date
            && Math.abs(result.transaction.amountYen) === Math.abs(item.row.amountYen)
            && result.transaction.kind === item.row.kind && result.transaction.payeeName === item.row.description.trim()
            && (result.transaction.categoryId ?? null) === categoryId && (result.transaction.memo ?? "") === item.row.memo;
          if (result.alreadyExisted && !matchingRecovered) {
            item.status = "duplicate";
            item.transactionSnapshot = null;
          } else {
            item.status = "created";
            item.transactionSnapshot = result.snapshot;
            importedIds.add(item.importedId);
          }
          item.error = null;
        } catch (error) {
          if (item.status !== "importing") item.status = "failed";
          item.error = error instanceof Error ? error.message : "登録に失敗しました。";
        }
        batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
        await this.save(state);
      }
      const failed = batch.rows.some(row => row.status === "failed" || row.status === "importing");
      batch.status = failed ? "partial" : "completed";
      batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.save(state);
      return clone(batch);
    });
  }

  async undo(batchId: string): Promise<MoneyForwardImportBatch> {
    return this.lock(async () => {
      const budgetId = this.options.getBudgetId();
      const state = await this.state();
      const batch = state.batches.find(row => row.id === batchId);
      if (!batch || batch.budgetId !== budgetId) throw new Error("移行バッチが見つからないか、別の家計簿の履歴です。");
      if (batch.status === "undone") return clone(batch);
      batch.status = "undoing";
      batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.save(state);
      for (const item of [...batch.rows].reverse()) {
        if (item.status !== "created" && item.status !== "undoing" && item.status !== "importing") continue;
        try {
          if (item.status === "importing") {
            const recovered = await this.ledger.getImportedTransaction(item.importedId);
            if (!recovered) {
              item.status = "undone";
              item.error = null;
              await this.save(state);
              continue;
            }
            const sourceAccount = item.row.accountName ?? "";
            const accountChoice = batch.mappings.accounts[sourceAccount];
            const accountId = accountChoice?.kind === "existing" ? accountChoice.accountId : null;
            const categoryChoice = batch.mappings.categories[categoryKey(item.row)];
            const categoryId = categoryChoice?.kind === "existing" ? categoryChoice.categoryId : categoryChoice?.kind === "unclassified" ? null : undefined;
            if (!accountId || recovered.transaction.accountId !== accountId || recovered.transaction.date !== item.row.date
              || Math.abs(recovered.transaction.amountYen) !== Math.abs(item.row.amountYen) || recovered.transaction.kind !== item.row.kind
              || recovered.transaction.payeeName !== item.row.description.trim()
              || (recovered.transaction.memo ?? "") !== item.row.memo || categoryId === undefined
              || (recovered.transaction.categoryId ?? null) !== categoryId) {
              throw new Error("登録途中の取引を安全に特定できません。取引一覧で内容を確認してください。");
            }
            item.status = "created";
            item.transactionSnapshot = recovered.snapshot;
          }
          if (!item.transactionSnapshot?.length) throw new Error("削除対象の取引を特定できません。取り消しを保留しました。");
          item.status = "undoing";
          await this.save(state);
          const current = await this.ledger.getTransactionTree(item.transactionSnapshot[0].id);
          if (current.length && current[0].imported_id !== item.importedId) throw new Error("移行元の識別子が変更されています。取引一覧で内容を確認してください。");
          // The user confirms removal of later edits too; capture the current native tree
          // and let the ledger reject any concurrent change between read and deletion.
          if (current.length) await this.ledger.deleteTransactionTree(current);
          item.status = "undone";
          item.transactionSnapshot = null;
          item.error = null;
        } catch (error) {
          item.error = error instanceof Error ? error.message : "取り消しに失敗しました。";
        }
        batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
        await this.save(state);
      }
      const failed = batch.rows.some(row => row.status === "created" || row.status === "undoing" || row.status === "importing");
      batch.status = failed ? "undo-partial" : "undone";
      batch.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      await this.save(state);
      return clone(batch);
    });
  }
}
