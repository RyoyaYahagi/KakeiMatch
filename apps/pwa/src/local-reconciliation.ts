import {
  merchantAliasKey,
  normalizeReconciliationMerchant,
  runReconciliationEngine,
  type ReconciliationEngineResult,
  type ReconciliationStatement,
  type ReconciliationReceipt,
} from "../../../src/lib/reconciliation-engine";
import type { LocalDataRecord, LocalDataRepository } from "../../../src/lib/local-data";
import type { ActualTransaction } from "../../../src/lib/actual-ledger";
import { sha256Hex } from "./statement-parser";
import type { StatementImportMetadata } from "./local-statements";
import type { StatementProvider } from "./statement-parser";

export type LocalReceipt = {
  id: string;
  confirmedValue: {
    merchant: string;
    purchasedDate: string;
    totalAmountYen: number;
    accountId: string;
  } | null;
  registration: {
    status: "pending" | "processing" | "applied" | "failed";
    actualTransactionId: string | null;
  };
};

export type LocalStatement = {
  id: string;
  importId: string;
  provider: string;
  externalId: string | null;
  kind: "purchase" | "refund";
  usedDate: string;
  postedDate: string | null;
  merchant: string;
  amountYen: number;
  paymentMethod: string | null;
  usedTime?: string | null;
  sourceFingerprint?: string;
  duplicateOrdinal?: number;
};

export type LocalRun = ReconciliationEngineResult & {
  runId: string;
  createdAt: string;
  completedAt: string;
  inputFingerprint?: string;
};

type ActualTransactionSnapshot = Pick<ActualTransaction, "date" | "amountYen" | "payeeName" | "accountId" | "isSplit">;
type StatementSnapshot = Pick<LocalStatement, "usedDate" | "merchant" | "kind">;

export type LocalResolution = {
  id: string;
  runId: string;
  statementId: string;
  resolution: "same_expense" | "no_receipt" | "transfer" | "ignored";
  destinationAccountId?: string;
  excludedFromSpending?: boolean;
  source: "automatic" | "user";
  receiptId: string | null;
  categoryId: string | null;
  accountId: string | null;
  statementAmountYen: number;
  importedId: string | null;
  status: "pending" | "processing" | "applied" | "failed";
  actualTransactionId: string | null;
  actualSnapshot?: ActualTransactionSnapshot;
  statementSnapshot?: StatementSnapshot;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserLedger = ReturnType<typeof import("../../../src/lib/actual-browser-ledger").createActualBrowserLedger>;
type PairRejection = { runId: string; statementId: string; receiptId: string };
type CandidateSource = { actualTransaction: ActualTransaction; receipt: LocalReceipt | null };
type StatementWindow = { importId: string; provider: StatementProvider; accountId: string | null; startDate: string; endDate: string; statements: LocalStatement[] };
type PreparedInput = {
  result: ReconciliationEngineResult;
  fingerprint: string;
  sourcesByCandidateId: Map<string, CandidateSource>;
  statementsById: Map<string, LocalStatement>;
};

const NATIVE_TRANSACTION_PREFIX = "actual:";
const nativeCandidateId = (transactionId: string) => `${NATIVE_TRANSACTION_PREFIX}${transactionId}`;
const actualSnapshot = (transaction: ActualTransaction): ActualTransactionSnapshot => ({
  date: transaction.date, amountYen: transaction.amountYen, payeeName: transaction.payeeName,
  accountId: transaction.accountId, isSplit: transaction.isSplit,
});
const matchesSnapshot = (transaction: ActualTransaction, snapshot: ActualTransactionSnapshot) =>
  transaction.kind === "expense" && transaction.date === snapshot.date && transaction.amountYen === snapshot.amountYen &&
  transaction.accountId === snapshot.accountId && transaction.payeeName === snapshot.payeeName &&
  Boolean(transaction.isSplit) === Boolean(snapshot.isSplit);
const matchesSnapshotFields = (transaction: ActualTransaction, snapshot: ActualTransactionSnapshot) =>
  transaction.kind === "expense" && transaction.date === snapshot.date && transaction.accountId === snapshot.accountId &&
  transaction.payeeName === snapshot.payeeName && Boolean(transaction.isSplit) === Boolean(snapshot.isSplit);
function shiftDate(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

export class LocalReconciliationError extends Error {
  constructor(readonly code: string) {
    const messages: Record<string, string> = {
      stale_run: "照合結果が更新されています。画面を更新してください。",
      candidate_unavailable: "この候補は現在の照合結果にありません。画面を更新してください。",
      decision_conflict: "この明細はすでに判断されています。画面を更新してください。",
      receipt_already_used: "このレシートは別の明細に使用済みです。",
      record_unavailable: "レシートまたは明細を利用できません。画面を更新してください。",
      candidates_remaining: "似たレシート候補を先に確認してください。",
      decision_unavailable: "この明細は支出として登録できません。",
      account_mapping_ambiguous: "同じカードの支払元が複数あります。設定の支払元で明細サービスの対応を1件にしてください。",
      destination_unavailable: "振替元と異なる利用中の振替先を選んでください。",
      account_unavailable: "支払元を選択してください。現金以外の利用中の支払元を選べます。",
      category_unavailable: "選択したカテゴリを利用できません。",
      retry_unavailable: "再試行できる判断記録がありません。",
      receipt_unavailable: "レシートの家計簿記録を見つけられません。",
      statement_unavailable: "明細を見つけられません。",
      resolution_snapshot_invalid: "判断内容を確認できません。",
      actual_readback_mismatch: "家計簿への反映を確認できませんでした。もう一度お試しください。",
      actual_apply_failed: "家計簿への反映に失敗しました。判断内容は保存されています。もう一度お試しください。",
      split_amount_adjustment_unsupported: "分割された記録の金額差は反映できません。内容を確認してから別の候補を選んでください。",
    };
    super(messages[code] ?? "照合を完了できませんでした。画面を更新して再試行してください。");
    this.name = "LocalReconciliationError";
  }
}

const now = () => new Date().toISOString();
const pairKey = (statementId: string, receiptId: string) => `${statementId}\0${receiptId}`;
const runRecordId = (runId: string) => `reconciliation-run:${runId}`;
const resultRecordId = (runId: string) => `reconciliation-result:${runId}`;
const latestRunPointerId = "reconciliation:latest-run";
const resolutionRecordId = (statementId: string) => `reconciliation-resolution:${statementId}`;
const rejectionRecordId = (runId: string, statementId: string, receiptId: string) =>
  `reconciliation-pair-rejection:${runId}:${encodeURIComponent(statementId)}:${encodeURIComponent(receiptId)}`;

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

const localTails = new Map<string, Promise<void>>();
async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = () => {
    const previous = localTails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    localTails.set(key, result.then(() => undefined, () => undefined));
    return result;
  };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request(`kakeimatch-local-reconciliation:${key}`, run) : run();
}

export class LocalReconciliationService {
  constructor(
    private readonly repo: LocalDataRepository,
    private readonly ledger: BrowserLedger,
    private readonly getStatementProvider: (accountId: string) => Promise<StatementProvider | null> = async () => null,
    private readonly setStatementProvider?: (accountId: string, provider: StatementProvider) => Promise<void>,
  ) {}

  private async prepareInput(): Promise<PreparedInput> {
    const [statementRecords, receiptRecords, resolutionRecords, rejectionRecords, aliasRecords, importRecords, accounts] = await Promise.all([
      this.repo.list<LocalStatement>("statement-transaction"),
      this.repo.list<LocalReceipt>("receipt-metadata"),
      this.repo.list<LocalResolution>("reconciliation-resolution"),
      this.repo.list<PairRejection>("correction-audit"),
      this.repo.list<{ merchant: string; aliasMerchant: string }>("merchant-mapping"),
      this.repo.list<StatementImportMetadata>("statement-import"),
      this.ledger.listAccounts(),
    ]);
    const statements = statementRecords.map(({ value }) => value);
    const statementById = new Map(statements.map((statement) => [statement.id, statement]));
    const importsById = new Map(importRecords.map(({ id, value }) => [id, value]));
    const priorResolutions = resolutionRecords.map(({ value }) => value);
    const excludedStatementIds = new Set(priorResolutions.map((item) => item.statementId));
    const excludedActualIds = new Set(priorResolutions.flatMap((item) => item.actualTransactionId ? [item.actualTransactionId] : []));
    const excludedImportedIds = new Set(priorResolutions.flatMap((item) => item.importedId ? [item.importedId] : []));
    const excludedReceiptIds = new Set(priorResolutions.filter((item) => item.resolution === "same_expense" && item.receiptId).map((item) => item.receiptId!));
    const rejected = rejectionRecords.map(({ value }) => value).filter((value) => value && "statementId" in value && "receiptId" in value) as PairRejection[];
    const aliases = new Set(aliasRecords.flatMap(({ value }) => value?.merchant && value.aliasMerchant
      ? [merchantAliasKey(value.merchant, value.aliasMerchant)] : []));

    const windowsByImport = new Map<string, StatementWindow>();
    for (const statement of statements) {
      const metadata = importsById.get(statement.importId);
      const provider = (metadata?.provider ?? statement.provider) as StatementProvider;
      const accountId = metadata?.accountId ?? null;
      const current = windowsByImport.get(statement.importId);
      if (current) {
        if (statement.usedDate < current.startDate) current.startDate = statement.usedDate;
        if (statement.usedDate > current.endDate) current.endDate = statement.usedDate;
        continue;
      }
      windowsByImport.set(statement.importId, { importId: statement.importId, provider, accountId,
        startDate: statement.usedDate, endDate: statement.usedDate, statements: [] });
    }
    for (const statement of statements) windowsByImport.get(statement.importId)?.statements.push(statement);
    const windows = [...windowsByImport.values()].map((window) => ({
      ...window, startDate: shiftDate(window.startDate, -7), endDate: shiftDate(window.endDate, 7),
    }));
    const rowsByImport = new Map<string, ActualTransaction[]>();
    const rowGroups = await Promise.all(windows.map(async (window) => [window.importId,
      await this.ledger.getTransactions({ startDate: window.startDate, endDate: window.endDate })] as const));
    for (const [importId, rows] of rowGroups) rowsByImport.set(importId, rows);
    const transactionsById = new Map<string, ActualTransaction>();
    for (const rows of rowsByImport.values()) for (const transaction of rows) {
      if (transaction.kind === "expense" && Number.isSafeInteger(transaction.amountYen) && transaction.amountYen < 0) transactionsById.set(transaction.id, transaction);
    }
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const accountProviders = new Map<string, StatementProvider | null>();
    await Promise.all(accounts.map(async (account) => accountProviders.set(account.id, await this.getStatementProvider(account.id))));

    const receiptByActualId = new Map<string, LocalReceipt>();
    for (const { value: receipt } of receiptRecords) {
      const actualId = receipt.registration.actualTransactionId;
      if (receipt.confirmedValue && receipt.registration.status === "applied" && actualId && !receiptByActualId.has(actualId)) {
        receiptByActualId.set(actualId, receipt);
      }
    }
    const sourcesByCandidateId = new Map<string, CandidateSource>();
    const engineReceipts: ReconciliationReceipt[] = [];
    for (const transaction of transactionsById.values()) {
      const account = accountsById.get(transaction.accountId);
      if (!account || account.accountType === "cash" || account.closed || transaction.cleared || excludedActualIds.has(transaction.id) ||
        (transaction.importedId && excludedImportedIds.has(transaction.importedId))) continue;
      const receipt = receiptByActualId.get(transaction.id) ?? null;
      const candidateId = receipt?.id ?? nativeCandidateId(transaction.id);
      const source = { actualTransaction: transaction, receipt };
      sourcesByCandidateId.set(candidateId, source);
      engineReceipts.push({
        receiptId: candidateId, actualTransactionId: transaction.id,
        merchant: transaction.payeeName ?? "", purchasedDate: transaction.date,
        amountYen: Math.abs(transaction.amountYen), actualAccountId: transaction.accountId,
      });
    }

    const engineStatements: ReconciliationStatement[] = statements.filter((statement) => !excludedStatementIds.has(statement.id)).map((statement) => ({
      statementTransactionId: statement.id, provider: statement.provider, externalId: statement.externalId,
      kind: statement.kind, usedDate: statement.usedDate, postedDate: statement.postedDate,
      merchant: statement.merchant, amountYen: statement.amountYen, paymentMethod: statement.paymentMethod,
    }));
    // Matching uses statement data only (date, amount, merchant, aliases). Payment-source metadata is
    // auxiliary: it decides which unmatched records are shown as waiting for this provider's statement.
    const waitsForWindow = (accountId: string, window: StatementWindow) => {
      const account = accountsById.get(accountId);
      return Boolean(account && account.accountType !== "cash" && !account.closed &&
        (accountProviders.get(accountId) === window.provider || accountId === window.accountId));
    };
    const waitingReceiptIds = new Set<string>();
    for (const window of windows) {
      for (const transaction of rowsByImport.get(window.importId) ?? []) {
        if (transaction.kind !== "expense" || transaction.cleared || transaction.amountYen >= 0 || !waitsForWindow(transaction.accountId, window) ||
          excludedActualIds.has(transaction.id) || (transaction.importedId && excludedImportedIds.has(transaction.importedId))) continue;
        const receipt = receiptByActualId.get(transaction.id) ?? null;
        waitingReceiptIds.add(receipt?.id ?? nativeCandidateId(transaction.id));
      }
    }

    const engineResult = runReconciliationEngine({
      statements: engineStatements, receipts: engineReceipts, aliases,
      excludedStatementIds, excludedReceiptIds,
      rejectedPairs: new Set(rejected.map((item) => pairKey(item.statementId, item.receiptId))),
    });
    const result: ReconciliationEngineResult = {
      ...engineResult,
      receiptResults: engineResult.receiptResults.filter((item) => waitingReceiptIds.has(item.receiptId)),
    };
    const referencedAccountIds = new Set([...rowsByImport.values()].flatMap((rows) => rows.map((transaction) => transaction.accountId)));
    const inputSnapshot = {
      statements: statements.map((statement) => [statement.id, statement.provider, statement.externalId, statement.kind,
        statement.usedDate, statement.postedDate, statement.merchant, statement.amountYen, statement.paymentMethod,
        statement.importId, statement.sourceFingerprint ?? null, statement.duplicateOrdinal ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      receipts: receiptRecords.map(({ value: receipt }) => [receipt.id, receipt.registration.status,
        receipt.registration.actualTransactionId, receipt.confirmedValue ? [receipt.confirmedValue.merchant,
          receipt.confirmedValue.purchasedDate, receipt.confirmedValue.totalAmountYen, receipt.confirmedValue.accountId] : null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      imports: importRecords.map(({ id, value }) => [id, value.provider, value.accountId ?? null, value.fileHash]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      transactions: [...transactionsById.values()].map((transaction) => [transaction.id, transaction.date, transaction.amountYen,
        transaction.payeeName, transaction.accountId, Boolean(transaction.isSplit), transaction.cleared]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      // Only accounts used by records in the matching windows affect the result; adding an unused payment
      // source (for example while registering an unrecorded statement) must not invalidate the run.
      accounts: accounts.filter((account) => referencedAccountIds.has(account.id)).map((account) => [account.id, account.name,
        account.accountType, account.closed, accountProviders.get(account.id) ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      resolutions: priorResolutions.map((item) => [item.statementId, item.resolution, item.receiptId, item.status,
        item.actualTransactionId, item.accountId, item.categoryId, item.statementAmountYen, item.importedId,
        item.actualSnapshot ?? null, item.statementSnapshot ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      rejected: rejected.map((item) => [item.runId, item.statementId, item.receiptId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      aliases: [...aliases].sort(),
    };
    const fingerprint = sha256Hex(new TextEncoder().encode(JSON.stringify(inputSnapshot)));
    return { result, fingerprint, sourcesByCandidateId, statementsById: statementById };
  }

  private async getLatestRecord(): Promise<LocalRun | null> {
    const pointer = await this.repo.get<{ runId: string }>(latestRunPointerId);
    if (pointer) return (await this.repo.get<LocalRun>(runRecordId(pointer.value.runId)))?.value ?? null;
    const runs = await this.repo.list<LocalRun>("reconciliation-run");
    return runs.map((row) => row.value).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.runId.localeCompare(a.runId))[0] ?? null;
  }

  async run(): Promise<LocalRun> {
    return serialize(this.repo.profileId, async () => {
      const prepared = await this.prepareInput();
      const completedAt = now();
      const runId = crypto.randomUUID();
      let run = freezeDeep({ ...prepared.result, runId, createdAt: completedAt, completedAt, inputFingerprint: prepared.fingerprint });
      await this.repo.put({ id: runRecordId(runId), kind: "reconciliation-run", value: run, updatedAt: completedAt });
      await this.repo.put({ id: resultRecordId(runId), kind: "reconciliation-result", value: prepared.result, updatedAt: completedAt });
      await this.repo.put({ id: latestRunPointerId, kind: "app-settings", value: { runId }, updatedAt: completedAt });

      const automatic = prepared.result.statementResults.flatMap((item) => item.status === "matched" && item.matchedReceiptId
        ? [{ statementId: item.statementTransactionId, receiptId: item.matchedReceiptId }] : []);
      const resolutionBatch: LocalResolution[] = automatic.map(({ statementId, receiptId }) => ({
        id: resolutionRecordId(statementId), runId, statementId, resolution: "same_expense", source: "automatic",
        receiptId, categoryId: null, accountId: null,
        statementAmountYen: prepared.statementsById.get(statementId)!.amountYen,
        importedId: null, status: "pending", actualTransactionId: prepared.sourcesByCandidateId.get(receiptId)!.actualTransaction.id,
        actualSnapshot: actualSnapshot(prepared.sourcesByCandidateId.get(receiptId)!.actualTransaction),
        statementSnapshot: { usedDate: prepared.statementsById.get(statementId)!.usedDate,
          merchant: prepared.statementsById.get(statementId)!.merchant, kind: prepared.statementsById.get(statementId)!.kind },
        errorCode: null, createdAt: completedAt, updatedAt: completedAt,
      }));
      for (const resolution of resolutionBatch) await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: completedAt });
      if (resolutionBatch.length) await this.applyBatch(resolutionBatch);
      const afterAutomaticMatches = await this.prepareInput();
      run = freezeDeep({ ...run, inputFingerprint: afterAutomaticMatches.fingerprint });
      await this.repo.put({ id: runRecordId(runId), kind: "reconciliation-run", value: run, updatedAt: now() });
      return run;
    });
  }

  async latest(): Promise<LocalRun | null> { return this.getLatestRecord(); }

  async resolutions(): Promise<LocalResolution[]> {
    return (await this.repo.list<LocalResolution>("reconciliation-resolution")).map((row) => row.value);
  }

  private async requireLatest(runId: string): Promise<{ run: LocalRun; prepared: PreparedInput }> {
    const [latest, stored] = await Promise.all([this.getLatestRecord(), this.repo.get<LocalRun>(runRecordId(runId))]);
    if (!latest || latest.runId !== runId || !stored || stored.value.runId !== runId) throw new LocalReconciliationError("stale_run");
    const prepared = await this.prepareInput();
    if (!stored.value.inputFingerprint || stored.value.inputFingerprint !== prepared.fingerprint) throw new LocalReconciliationError("stale_run");
    return { run: stored.value, prepared };
  }

  async sameExpense(runId: string, statementId: string, receiptId: string): Promise<LocalResolution> {
    return serialize(this.repo.profileId, async () => {
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const { run, prepared } = await this.requireLatest(runId);
      const candidate = run.candidates.find((item) => item.statementTransactionId === statementId && item.receiptId === receiptId);
      if (!candidate) throw new LocalReconciliationError("candidate_unavailable");
      const [statementRecord, existing, priorResolutions] = await Promise.all([
        this.findStatement(statementId), this.repo.get<LocalResolution>(resolutionRecordId(statementId)),
        this.repo.list<LocalResolution>("reconciliation-resolution"),
      ]);
      const source = prepared.sourcesByCandidateId.get(receiptId);
      if (!statementRecord || !source || existing) throw new LocalReconciliationError("decision_conflict");
      if (priorResolutions.some(({ value }) => value.resolution === "same_expense" && value.receiptId === receiptId)) throw new LocalReconciliationError("receipt_already_used");
      const statement = statementRecord.value;
      const transaction = source.actualTransaction;
      if (statement.kind !== "purchase" || transaction.kind !== "expense") throw new LocalReconciliationError("record_unavailable");
      if (transaction.isSplit && transaction.amountYen !== -statement.amountYen) throw new LocalReconciliationError("split_amount_adjustment_unsupported");
      const timestamp = now();
      const resolution: LocalResolution = {
        id: resolutionRecordId(statementId), runId, statementId, resolution: "same_expense", source: "user",
        receiptId, categoryId: null, accountId: null, statementAmountYen: statement.amountYen, importedId: null,
        status: "pending", actualTransactionId: transaction.id, actualSnapshot: actualSnapshot(transaction), errorCode: null,
        createdAt: timestamp, updatedAt: timestamp,
      };
      await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: timestamp });
      if (transaction.payeeName && statement.merchant !== transaction.payeeName) await this.saveAlias(statement.merchant, transaction.payeeName);
      const updated = await this.applyOne(resolution);
      return updated;
    });
  }

  async rejectPair(runId: string, statementId: string, receiptId: string): Promise<void> {
    return serialize(this.repo.profileId, async () => {
      const { run } = await this.requireLatest(runId);
      if (!run.candidates.some((item) => item.statementTransactionId === statementId && item.receiptId === receiptId)) throw new LocalReconciliationError("candidate_unavailable");
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const id = rejectionRecordId(runId, statementId, receiptId);
      if (await this.repo.get(id)) throw new LocalReconciliationError("decision_conflict");
      const value: PairRejection = { runId, statementId, receiptId };
      await this.repo.put({ id, kind: "correction-audit", value, updatedAt: now() });
    });
  }

  async registrationAccount(provider: StatementProvider): Promise<string> {
    const accounts = (await this.ledger.listOpenAccounts()).filter(row => row.accountType !== "cash");
    const mapped = (await Promise.all(accounts.map(async row => ({ row, provider: await this.getStatementProvider(row.id) })))).filter(item => item.provider === provider);
    if (mapped.length > 1) throw new LocalReconciliationError("account_mapping_ambiguous");
    if (mapped.length === 1) return mapped[0]!.row.id;
    if (!this.setStatementProvider) throw new LocalReconciliationError("account_unavailable");
    const names: Record<StatementProvider, string> = { rakuten_card: "楽天カード", smbc_card: "三井住友カード", paypay_card: "PayPayカード", paypay: "PayPay", aeon_card: "イオンカード" };
    const named = accounts.filter(row => row.name === names[provider]);
    if (named[0] && await this.getStatementProvider(named[0].id)) throw new LocalReconciliationError("account_mapping_ambiguous");
    if (named.length > 1) throw new LocalReconciliationError("account_mapping_ambiguous");
    const accountId = named[0]?.id ?? await this.ledger.addAccount(names[provider], "credit_card");
    await this.setStatementProvider(accountId, provider);
    return accountId;
  }

  async ignore(runId: string, statementId: string): Promise<LocalResolution> {
    return serialize(this.repo.profileId, async () => {
      const { run } = await this.requireLatest(runId);
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const result = run.statementResults.find(row => row.statementTransactionId === statementId);
      const statement = (await this.findStatement(statementId))?.value;
      if (!result || result.status === "matched" || !statement) throw new LocalReconciliationError("decision_unavailable");
      const timestamp = now();
      return this.storeResolution({ id: resolutionRecordId(statementId), runId, statementId, resolution: "ignored", source: "user",
        receiptId: null, categoryId: null, accountId: null, statementAmountYen: statement.amountYen, importedId: null,
        status: "applied", actualTransactionId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp });
    });
  }

  async noReceipt(runId: string, statementId: string, options: { accountId?: string; categoryId?: string; destinationAccountId?: string; excludedFromSpending?: boolean }): Promise<LocalResolution> {
    return serialize(this.repo.profileId, async () => {
      const { run } = await this.requireLatest(runId);
      const result = run.statementResults.find((item) => item.statementTransactionId === statementId);
      const statementRecord = await this.findStatement(statementId);
      if (!result || result.status === "matched" || !statementRecord || statementRecord.value.kind !== "purchase") throw new LocalReconciliationError("decision_unavailable");
      const candidates = run.candidates.filter((item) => item.statementTransactionId === statementId);
      const rejected = new Set((await this.repo.list<PairRejection>("correction-audit")).filter(item => "statementId" in item.value && "receiptId" in item.value).map((item) => pairKey(item.value.statementId, item.value.receiptId)));
      if (candidates.some((candidate) => !rejected.has(pairKey(statementId, candidate.receiptId)))) throw new LocalReconciliationError("candidates_remaining");
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const [accounts, categories] = await Promise.all([this.ledger.listOpenAccounts(), this.ledger.listExpenseCategories()]);
      // A payment source is needed only here, because a new ledger transaction must belong to an account.
      const accountId = this.setStatementProvider ? await this.registrationAccount(statementRecord.value.provider as StatementProvider) : options.accountId;
      if (!accountId || !(await this.ledger.listOpenAccounts()).some((account) => account.id === accountId && account.accountType !== "cash")) throw new LocalReconciliationError("account_unavailable");
      if (options.destinationAccountId && (options.destinationAccountId === accountId || !accounts.some(row => row.id === options.destinationAccountId))) throw new LocalReconciliationError("destination_unavailable");
      if (!options.destinationAccountId && !categories.some((category) => category.id === options.categoryId)) throw new LocalReconciliationError("category_unavailable");
      const statement = statementRecord.value;
      const timestamp = now();
      const resolution: LocalResolution = {
        id: resolutionRecordId(statementId), runId, statementId, resolution: options.destinationAccountId ? "transfer" : "no_receipt", source: "user",
        ...(options.destinationAccountId ? { destinationAccountId: options.destinationAccountId } : {}),
        ...(options.excludedFromSpending !== undefined ? { excludedFromSpending: options.excludedFromSpending } : {}),
        receiptId: null, categoryId: options.destinationAccountId ? null : options.categoryId!, accountId,
        statementAmountYen: statement.amountYen, importedId: `kakeimatch:statement:${statement.id}`,
        status: "pending", actualTransactionId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp,
        statementSnapshot: { usedDate: statement.usedDate, merchant: statement.merchant, kind: statement.kind },
      };
      await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: timestamp });
      return this.applyOne(resolution);
    });
  }

  async retry(resolutionId: string): Promise<LocalResolution> {
    return serialize(this.repo.profileId, async () => {
      const record = await this.repo.get<LocalResolution>(resolutionId);
      if (!record || record.value.status === "applied") throw new LocalReconciliationError("retry_unavailable");
      const run = await this.repo.get<LocalRun>(runRecordId(record.value.runId));
      if (!run) throw new LocalReconciliationError("stale_run");
      return this.applyOne(record.value);
    });
  }

  private async findStatement(id: string): Promise<LocalDataRecord<LocalStatement> | null> {
    return (await this.repo.list<LocalStatement>("statement-transaction")).find((row) => row.value.id === id) ?? null;
  }
  private async findReceipt(id: string): Promise<LocalDataRecord<LocalReceipt> | null> {
    const direct = await this.repo.get<LocalReceipt>(id);
    if (direct?.kind === "receipt-metadata") return direct;
    return (await this.repo.list<LocalReceipt>("receipt-metadata")).find((row) => row.value.id === id) ?? null;
  }

  private async saveAlias(merchant: string, aliasMerchant: string): Promise<void> {
    const key = merchantAliasKey(merchant, aliasMerchant);
    const id = `merchant-alias:${encodeURIComponent(key)}`;
    if (await this.repo.get(id)) return;
    await this.repo.put({ id, kind: "merchant-mapping", value: { merchant, aliasMerchant }, updatedAt: now() });
  }

  private async storeResolution(resolution: LocalResolution): Promise<LocalResolution> {
    const updated = { ...resolution, updatedAt: now() };
    await this.repo.put({ id: updated.id, kind: "reconciliation-resolution", value: updated, updatedAt: updated.updatedAt });
    return updated;
  }

  private async hydrateLegacySnapshot(resolution: LocalResolution): Promise<LocalResolution> {
    if (resolution.resolution !== "same_expense" || resolution.actualSnapshot) return resolution;
    if (!resolution.receiptId || !resolution.actualTransactionId) throw new LocalReconciliationError("resolution_snapshot_invalid");
    const receiptRecord = await this.findReceipt(resolution.receiptId);
    const receipt = receiptRecord?.value;
    const confirmed = receipt?.confirmedValue;
    if (!receipt || !confirmed || receipt.registration.actualTransactionId !== resolution.actualTransactionId) {
      throw new LocalReconciliationError("resolution_snapshot_invalid");
    }
    const transaction = await this.ledger.getTransactionById(resolution.actualTransactionId);
    const merchantMatches = transaction?.payeeName !== null && transaction?.payeeName !== undefined &&
      normalizeReconciliationMerchant(transaction.payeeName) === normalizeReconciliationMerchant(confirmed.merchant);
    const originalAmount = -confirmed.totalAmountYen;
    const targetAmount = -resolution.statementAmountYen;
    const hasOriginalAmount = transaction?.amountYen === originalAmount;
    const alreadyClearedTarget = resolution.source === "user" && transaction?.cleared === true && transaction.amountYen === targetAmount;
    if (!transaction || transaction.kind !== "expense" || transaction.date !== confirmed.purchasedDate ||
      transaction.accountId !== confirmed.accountId || !merchantMatches || (!hasOriginalAmount && !alreadyClearedTarget) ||
      (resolution.source === "automatic" && transaction.amountYen !== targetAmount) ||
      (transaction.isSplit && transaction.amountYen !== targetAmount)) {
      throw new LocalReconciliationError("actual_readback_mismatch");
    }
    return { ...resolution, actualSnapshot: actualSnapshot(transaction) };
  }

  private async applyOne(input: LocalResolution): Promise<LocalResolution> {
    let resolution = input;
    try {
      resolution = await this.hydrateLegacySnapshot(resolution);
      resolution = await this.storeResolution({ ...resolution, status: "processing", errorCode: null });
      if (resolution.resolution === "same_expense") {
        if (!resolution.receiptId || !resolution.actualTransactionId || !resolution.actualSnapshot) throw new LocalReconciliationError("resolution_snapshot_invalid");
        const current = await this.ledger.getTransactionById(resolution.actualTransactionId);
        if (!current || !matchesSnapshotFields(current, resolution.actualSnapshot)) throw new LocalReconciliationError("actual_readback_mismatch");
        const targetAmount = -resolution.statementAmountYen;
        const amountAlreadyApplied = resolution.source === "user" && !current.isSplit && current.amountYen === targetAmount && current.cleared;
        if (!matchesSnapshot(current, resolution.actualSnapshot) && !amountAlreadyApplied) throw new LocalReconciliationError("actual_readback_mismatch");
        if (resolution.source === "automatic" && current.amountYen !== targetAmount) throw new LocalReconciliationError("actual_readback_mismatch");
        if (current.isSplit && current.amountYen !== targetAmount) throw new LocalReconciliationError("split_amount_adjustment_unsupported");
        await this.ledger.applyTransactionUpdates([{ transactionId: resolution.actualTransactionId,
          ...(resolution.source === "user" && current.amountYen !== targetAmount ? { amountYen: targetAmount } : {}), cleared: true }]);
        const actual = await this.ledger.getTransactionById(resolution.actualTransactionId);
        if (!actual || !matchesSnapshotFields(actual, resolution.actualSnapshot) || !actual.cleared ||
          (resolution.source === "user" && actual.amountYen !== targetAmount) ||
          (resolution.source === "automatic" && actual.amountYen !== resolution.actualSnapshot.amountYen)) {
          throw new LocalReconciliationError("actual_readback_mismatch");
        }
      } else {
        if (!resolution.accountId || (resolution.resolution !== "transfer" && !resolution.categoryId) || !resolution.importedId) throw new LocalReconciliationError("resolution_snapshot_invalid");
        const statement = resolution.statementSnapshot ?? (await this.findStatement(resolution.statementId))?.value;
        if (!statement || statement.kind !== "purchase") throw new LocalReconciliationError("statement_unavailable");
        if (resolution.resolution === "transfer" && !resolution.destinationAccountId) throw new LocalReconciliationError("resolution_snapshot_invalid");
        const imported = resolution.resolution === "transfer"
          ? await this.ledger.createTransfer({ sourceAccountId: resolution.accountId, destinationAccountId: resolution.destinationAccountId!, date: statement.usedDate,
            amountYen: resolution.statementAmountYen, memo: statement.merchant, importedId: resolution.importedId })
          : await this.ledger.importReceipt({ accountId: resolution.accountId, date: statement.usedDate,
          amountYen: -resolution.statementAmountYen, merchant: statement.merchant,
          categoryId: resolution.categoryId!, importedId: resolution.importedId });
        await this.ledger.applyTransactionUpdates([{ transactionId: imported.id, cleared: true }]);
        const actual = await this.ledger.getTransactionById(imported.id);
        if (!actual || actual.kind !== (resolution.resolution === "transfer" ? "transfer" : "expense") || !actual.cleared || actual.amountYen !== -resolution.statementAmountYen ||
          actual.accountId !== resolution.accountId || actual.date !== statement.usedDate ||
          (resolution.resolution === "transfer" ? actual.transferAccountId !== resolution.destinationAccountId : actual.payeeName === null || normalizeReconciliationMerchant(actual.payeeName) !== normalizeReconciliationMerchant(statement.merchant))) {
          throw new LocalReconciliationError("actual_readback_mismatch");
        }
        if (resolution.resolution === "no_receipt" && resolution.excludedFromSpending !== undefined) await this.ledger.setSpendingExclusion(imported.id, resolution.excludedFromSpending);
        resolution = { ...resolution, actualTransactionId: imported.id };
      }
      return this.storeResolution({ ...resolution, status: "applied", errorCode: null });
    } catch (error) {
      const failed = await this.storeResolution({ ...resolution, status: "failed", errorCode: error instanceof LocalReconciliationError ? error.code : "actual_apply_failed" });
      return failed;
    }
  }

  private async applyBatch(resolutions: LocalResolution[]): Promise<void> {
    const processing = await Promise.all(resolutions.map((item) => this.storeResolution({ ...item, status: "processing" })));
    try {
      const before = await Promise.all(processing.map((item) => item.actualTransactionId ? this.ledger.getTransactionById(item.actualTransactionId) : Promise.resolve(null)));
      if (processing.some((item, index) => !item.actualSnapshot || !before[index] ||
        !matchesSnapshot(before[index]!, item.actualSnapshot!) ||
        before[index]!.amountYen !== -item.statementAmountYen)) throw new LocalReconciliationError("actual_readback_mismatch");
      const updates = processing.map((item) => ({ transactionId: item.actualTransactionId!, cleared: true as const }));
      await this.ledger.applyTransactionUpdates(updates);
      const checks = await Promise.all(processing.map((item) => this.ledger.getTransactionById(item.actualTransactionId!)));
      if (checks.some((transaction, index) => !transaction || !transaction.cleared ||
        !matchesSnapshotFields(transaction, processing[index]!.actualSnapshot!) ||
        transaction.amountYen !== processing[index]!.actualSnapshot!.amountYen)) throw new LocalReconciliationError("actual_readback_mismatch");
      await Promise.all(processing.map((item) => this.storeResolution({ ...item, status: "applied" })));
    } catch (error) {
      await Promise.all(processing.map((item) => this.storeResolution({ ...item, status: "failed", errorCode: error instanceof LocalReconciliationError ? error.code : "actual_apply_failed" })));
    }
  }
}
