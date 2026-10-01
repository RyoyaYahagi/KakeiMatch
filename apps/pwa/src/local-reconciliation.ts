import {
  merchantAliasKey,
  runReconciliationEngine,
  type ReconciliationEngineResult,
  type ReconciliationStatement,
  type ReconciliationReceipt,
} from "../../../src/lib/reconciliation-engine";
import type { LocalDataRecord, LocalDataRepository } from "../../../src/lib/local-data";

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
};

export type LocalResolution = {
  id: string;
  runId: string;
  statementId: string;
  resolution: "same_expense" | "no_receipt";
  source: "automatic" | "user";
  receiptId: string | null;
  categoryId: string | null;
  accountId: string | null;
  statementAmountYen: number;
  importedId: string | null;
  status: "pending" | "processing" | "applied" | "failed";
  actualTransactionId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserLedger = ReturnType<typeof import("../../../src/lib/actual-browser-ledger").createActualBrowserLedger>;
type PairRejection = { runId: string; statementId: string; receiptId: string };

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
      account_unavailable: "選択した支払元を利用できません。",
      category_unavailable: "選択したカテゴリを利用できません。",
      retry_unavailable: "再試行できる判断記録がありません。",
      receipt_unavailable: "レシートの家計簿記録を見つけられません。",
      statement_unavailable: "明細を見つけられません。",
      resolution_snapshot_invalid: "判断内容を確認できません。",
      actual_readback_mismatch: "家計簿への反映を確認できませんでした。もう一度お試しください。",
      actual_apply_failed: "家計簿への反映に失敗しました。判断内容は保存されています。もう一度お試しください。",
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

let localTail: Promise<void> = Promise.resolve();
async function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = () => {
    const result = localTail.then(task, task);
    localTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request("kakeimatch-local-reconciliation", run) : run();
}

export class LocalReconciliationService {
  constructor(private readonly repo: LocalDataRepository, private readonly ledger: BrowserLedger) {}

  private async getLatestRecord(): Promise<LocalRun | null> {
    const pointer = await this.repo.get<{ runId: string }>(latestRunPointerId);
    if (pointer) return (await this.repo.get<LocalRun>(runRecordId(pointer.value.runId)))?.value ?? null;
    const runs = await this.repo.list<LocalRun>("reconciliation-run");
    return runs.map((row) => row.value).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.runId.localeCompare(a.runId))[0] ?? null;
  }

  async run(): Promise<LocalRun> {
    return serialize(async () => {
      const [statementRecords, receiptRecords, resolutionRecords, rejectionRecords, aliasRecords] = await Promise.all([
        this.repo.list<LocalStatement>("statement-transaction"),
        this.repo.list<LocalReceipt>("receipt-metadata"),
        this.repo.list<LocalResolution>("reconciliation-resolution"),
        this.repo.list<PairRejection>("correction-audit"),
        this.repo.list<{ merchant: string; aliasMerchant: string }>("merchant-mapping"),
      ]);
      const statements = statementRecords.map((row) => row.value);
      const receipts = receiptRecords.map((row) => row.value);
      const priorResolutions = resolutionRecords.map((row) => row.value);
      const rejected = rejectionRecords.map((row) => row.value).filter((value) => value && "statementId" in value && "receiptId" in value) as PairRejection[];
      const engineStatements: ReconciliationStatement[] = statements.map((statement) => ({
        statementTransactionId: statement.id, provider: statement.provider, externalId: statement.externalId,
        kind: statement.kind, usedDate: statement.usedDate, postedDate: statement.postedDate,
        merchant: statement.merchant, amountYen: statement.amountYen, paymentMethod: statement.paymentMethod,
      }));
      const engineReceipts: ReconciliationReceipt[] = receipts.flatMap((receipt) => {
        const confirmed = receipt.confirmedValue;
        if (!confirmed || receipt.registration.status !== "applied" || !receipt.registration.actualTransactionId) return [];
        return [{ receiptId: receipt.id, actualTransactionId: receipt.registration.actualTransactionId,
          merchant: confirmed.merchant, purchasedDate: confirmed.purchasedDate, amountYen: confirmed.totalAmountYen,
          actualAccountId: confirmed.accountId }];
      });
      const aliases = new Set(aliasRecords.flatMap(({ value }) => value?.merchant && value.aliasMerchant
        ? [merchantAliasKey(value.merchant, value.aliasMerchant)] : []));
      const result = runReconciliationEngine({
        statements: engineStatements,
        receipts: engineReceipts,
        aliases,
        excludedStatementIds: new Set(priorResolutions.map((item) => item.statementId)),
        excludedReceiptIds: new Set(priorResolutions.filter((item) => item.resolution === "same_expense" && item.receiptId).map((item) => item.receiptId!)),
        rejectedPairs: new Set(rejected.map((item) => pairKey(item.statementId, item.receiptId))),
      });
      const completedAt = now();
      const runId = crypto.randomUUID();
      const run = freezeDeep({ ...result, runId, createdAt: completedAt, completedAt });
      await this.repo.put({ id: runRecordId(runId), kind: "reconciliation-run", value: run, updatedAt: completedAt });
      await this.repo.put({ id: resultRecordId(runId), kind: "reconciliation-result", value: result, updatedAt: completedAt });
      await this.repo.put({ id: latestRunPointerId, kind: "app-settings", value: { runId }, updatedAt: completedAt });

      const automatic = result.statementResults.flatMap((item) => item.status === "matched" && item.matchedReceiptId
        ? [{ statementId: item.statementTransactionId, receiptId: item.matchedReceiptId }] : []);
      const receiptById = new Map(engineReceipts.map((receipt) => [receipt.receiptId, receipt]));
      const resolutionBatch: LocalResolution[] = automatic.map(({ statementId, receiptId }) => ({
        id: resolutionRecordId(statementId), runId, statementId, resolution: "same_expense", source: "automatic",
        receiptId, categoryId: null, accountId: null,
        statementAmountYen: statements.find((item) => item.id === statementId)!.amountYen,
        importedId: null, status: "pending", actualTransactionId: receiptById.get(receiptId)!.actualTransactionId,
        errorCode: null, createdAt: completedAt, updatedAt: completedAt,
      }));
      for (const resolution of resolutionBatch) await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: completedAt });
      if (resolutionBatch.length) await this.applyBatch(resolutionBatch);
      return run;
    });
  }

  async latest(): Promise<LocalRun | null> { return this.getLatestRecord(); }

  async resolutions(): Promise<LocalResolution[]> {
    return (await this.repo.list<LocalResolution>("reconciliation-resolution")).map((row) => row.value);
  }

  private async requireLatest(runId: string): Promise<LocalRun> {
    const [latest, stored] = await Promise.all([this.getLatestRecord(), this.repo.get<LocalRun>(runRecordId(runId))]);
    if (!latest || latest.runId !== runId || !stored || stored.value.runId !== runId) throw new LocalReconciliationError("stale_run");
    return stored.value;
  }

  async sameExpense(runId: string, statementId: string, receiptId: string): Promise<LocalResolution> {
    return serialize(async () => {
      const run = await this.requireLatest(runId);
      const candidate = run.candidates.find((item) => item.statementTransactionId === statementId && item.receiptId === receiptId);
      if (!candidate) throw new LocalReconciliationError("candidate_unavailable");
      const [statementRecord, receiptRecord, existing, priorResolutions] = await Promise.all([
        this.repo.get<LocalStatement>(`statement-transaction:${statementId}`).then((value) => value ?? this.findStatement(statementId)),
        this.findReceipt(receiptId), this.repo.get<LocalResolution>(resolutionRecordId(statementId)),
        this.repo.list<LocalResolution>("reconciliation-resolution"),
      ]);
      if (!statementRecord || !receiptRecord || existing) throw new LocalReconciliationError("decision_conflict");
      if (priorResolutions.some(({ value }) => value.resolution === "same_expense" && value.receiptId === receiptId)) throw new LocalReconciliationError("receipt_already_used");
      const statement = statementRecord.value;
      const receipt = receiptRecord.value;
      if (statement.kind !== "purchase" || !receipt.confirmedValue || receipt.registration.status !== "applied" || !receipt.registration.actualTransactionId) throw new LocalReconciliationError("record_unavailable");
      const timestamp = now();
      const resolution: LocalResolution = {
        id: resolutionRecordId(statementId), runId, statementId, resolution: "same_expense", source: "user",
        receiptId, categoryId: null, accountId: null, statementAmountYen: statement.amountYen, importedId: null,
        status: "pending", actualTransactionId: receipt.registration.actualTransactionId, errorCode: null,
        createdAt: timestamp, updatedAt: timestamp,
      };
      await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: timestamp });
      if (statement.merchant !== receipt.confirmedValue.merchant) await this.saveAlias(statement.merchant, receipt.confirmedValue.merchant);
      const updated = await this.applyOne(resolution);
      return updated;
    });
  }

  async rejectPair(runId: string, statementId: string, receiptId: string): Promise<void> {
    return serialize(async () => {
      const run = await this.requireLatest(runId);
      if (!run.candidates.some((item) => item.statementTransactionId === statementId && item.receiptId === receiptId)) throw new LocalReconciliationError("candidate_unavailable");
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const id = rejectionRecordId(runId, statementId, receiptId);
      if (await this.repo.get(id)) throw new LocalReconciliationError("decision_conflict");
      const value: PairRejection = { runId, statementId, receiptId };
      await this.repo.put({ id, kind: "correction-audit", value, updatedAt: now() });
    });
  }

  async noReceipt(runId: string, statementId: string, options: { accountId: string; categoryId: string }): Promise<LocalResolution> {
    return serialize(async () => {
      const run = await this.requireLatest(runId);
      const result = run.statementResults.find((item) => item.statementTransactionId === statementId);
      const statementRecord = await this.findStatement(statementId);
      if (!result || result.status === "matched" || !statementRecord || statementRecord.value.kind !== "purchase") throw new LocalReconciliationError("decision_unavailable");
      const candidates = run.candidates.filter((item) => item.statementTransactionId === statementId);
      const rejected = new Set((await this.repo.list<PairRejection>("correction-audit")).filter(item => "statementId" in item.value && "receiptId" in item.value).map((item) => pairKey(item.value.statementId, item.value.receiptId)));
      if (candidates.some((candidate) => !rejected.has(pairKey(statementId, candidate.receiptId)))) throw new LocalReconciliationError("candidates_remaining");
      if (await this.repo.get(resolutionRecordId(statementId))) throw new LocalReconciliationError("decision_conflict");
      const [accounts, categories] = await Promise.all([this.ledger.listOpenAccounts(), this.ledger.listExpenseCategories()]);
      if (!accounts.some((account) => account.id === options.accountId)) throw new LocalReconciliationError("account_unavailable");
      if (!categories.some((category) => category.id === options.categoryId)) throw new LocalReconciliationError("category_unavailable");
      const statement = statementRecord.value;
      const timestamp = now();
      const resolution: LocalResolution = {
        id: resolutionRecordId(statementId), runId, statementId, resolution: "no_receipt", source: "user",
        receiptId: null, categoryId: options.categoryId, accountId: options.accountId,
        statementAmountYen: statement.amountYen, importedId: `kakeimatch:statement:${statement.id}`,
        status: "pending", actualTransactionId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp,
      };
      await this.repo.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: timestamp });
      return this.applyOne(resolution);
    });
  }

  async retry(resolutionId: string): Promise<LocalResolution> {
    return serialize(async () => {
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

  private async applyOne(input: LocalResolution): Promise<LocalResolution> {
    let resolution = await this.storeResolution({ ...input, status: "processing", errorCode: null });
    try {
      if (resolution.resolution === "same_expense") {
        if (!resolution.receiptId || !resolution.actualTransactionId) throw new LocalReconciliationError("receipt_unavailable");
        await this.ledger.applyTransactionUpdates([{ transactionId: resolution.actualTransactionId,
          ...(resolution.source === "user" ? { amountYen: -resolution.statementAmountYen } : {}), cleared: true }]);
        const actual = await this.ledger.getTransactionById(resolution.actualTransactionId);
        if (!actual || actual.kind !== "expense" || !actual.cleared || (resolution.source === "user" && actual.amountYen !== -resolution.statementAmountYen)) throw new LocalReconciliationError("actual_readback_mismatch");
      } else {
        if (!resolution.accountId || !resolution.categoryId || !resolution.importedId) throw new LocalReconciliationError("resolution_snapshot_invalid");
        const statement = await this.findStatement(resolution.statementId);
        if (!statement || statement.value.kind !== "purchase") throw new LocalReconciliationError("statement_unavailable");
        const imported = await this.ledger.importReceipt({ accountId: resolution.accountId, date: statement.value.usedDate,
          amountYen: -resolution.statementAmountYen, merchant: statement.value.merchant,
          categoryId: resolution.categoryId, importedId: resolution.importedId });
        await this.ledger.applyTransactionUpdates([{ transactionId: imported.id, cleared: true }]);
        const actual = await this.ledger.getTransactionById(imported.id);
        if (!actual || actual.kind !== "expense" || !actual.cleared || actual.amountYen !== -resolution.statementAmountYen || actual.accountId !== resolution.accountId || actual.date !== statement.value.usedDate) throw new LocalReconciliationError("actual_readback_mismatch");
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
      const updates = processing.map((item) => ({ transactionId: item.actualTransactionId!, cleared: true as const }));
      await this.ledger.applyTransactionUpdates(updates);
      const checks = await Promise.all(processing.map((item) => this.ledger.getTransactionById(item.actualTransactionId!)));
      if (checks.some((item) => !item || item.kind !== "expense" || !item.cleared)) throw new LocalReconciliationError("actual_readback_mismatch");
      await Promise.all(processing.map((item) => this.storeResolution({ ...item, status: "applied" })));
    } catch (error) {
      await Promise.all(processing.map((item) => this.storeResolution({ ...item, status: "failed", errorCode: error instanceof LocalReconciliationError ? error.code : "actual_apply_failed" })));
    }
  }
}
