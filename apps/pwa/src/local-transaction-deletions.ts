import type { LocalDataRecord, LocalDataRepository } from "../../../src/lib/local-data";
import type { NativeTransactionSnapshot } from "../../../src/lib/actual-browser-ledger";
import type { LocalReceipt } from "./local-receipts";

const AUDIT_KIND = "correction-audit" as const;
const RECEIPT_KIND = "receipt-metadata" as const;
const UNDO_WINDOW_MS = 10_000;

export type DeletionAudit = {
  targetType: "deletion";
  transactionId: string;
  operationId: string;
  nativeSnapshot: NativeTransactionSnapshot[];
  receiptBefore: LocalReceipt[];
  status: "pending" | "deleted" | "restoring" | "restored";
  createdAt: string;
  deletedAt: string | null;
  undoUntil: string;
  completedAt: string | null;
};

type DeletionLedger = {
  getTransactionTree(id: string): Promise<NativeTransactionSnapshot[]>;
  deleteTransactionTree(snapshot: NativeTransactionSnapshot[]): Promise<void>;
  restoreTransactionTree(snapshot: NativeTransactionSnapshot[]): Promise<void>;
  skipDeletedScheduleOccurrences?(snapshot: NativeTransactionSnapshot[]): Promise<void>;
};
export type LocalTransactionDeletionOptions = {
  now?: () => Date;
  makeId?: () => string;
  withLock?: <T>(keys: string[], operation: () => Promise<T>) => Promise<T>;
};

export class LocalTransactionDeletionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalTransactionDeletionError";
  }
}

function timestamp(options: LocalTransactionDeletionOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
function deletionAuditId(operationId: string): string { return `transaction-deletion:${operationId}`; }
function matchesReceipt(receipt: LocalReceipt, snapshot: NativeTransactionSnapshot[], ids: Set<string>): boolean {
  return (receipt.registration.actualTransactionId !== null && ids.has(receipt.registration.actualTransactionId)) ||
    snapshot.some(row => row.imported_id === `kakeimatch:${receipt.id}`);
}
function lockKeys(ids: string[], receiptIds: string[] = []): string[] {
  return [...ids.map(id => `kakeimatch-manual-transaction:${id}`), ...receiptIds.map(receiptId => `kakeimatch-register:${receiptId}`)].sort();
}

export class LocalTransactionDeletionService {
  constructor(
    private readonly repository: LocalDataRepository,
    private readonly ledger: DeletionLedger,
    private readonly options: LocalTransactionDeletionOptions = {},
  ) {}

  async list(): Promise<DeletionAudit[]> {
    return (await this.repository.list<DeletionAudit>(AUDIT_KIND))
      .map(({ value }) => value)
      .filter(value => value?.targetType === "deletion")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async delete(id: string): Promise<DeletionAudit> {
    const initialTree = await this.requireTree(id);
    const initialIds = new Set(initialTree.map(row => row.id));
    const receipts = await this.repository.list<LocalReceipt>(RECEIPT_KIND);
    const linked = receipts.map(row => row.value).filter(receipt => matchesReceipt(receipt, initialTree, initialIds));
    return this.withLocks(lockKeys([...initialIds], linked.map(receipt => receipt.id)), async () => {
      const nativeSnapshot = await this.requireTree(id);
      const ids = new Set(nativeSnapshot.map(row => row.id));
      const currentReceipts = await this.repository.list<LocalReceipt>(RECEIPT_KIND);
      const linkedReceipts = currentReceipts.map(row => row.value).filter(receipt => matchesReceipt(receipt, nativeSnapshot, ids));
      if (linkedReceipts.some(receipt => receipt.registration.status === "deleted")) {
        throw new LocalTransactionDeletionError("already_deleted", "この取引はすでに削除されています。");
      }
      const receiptBefore = linkedReceipts.filter(receipt => receipt.registration.status === "applied");
      if (linkedReceipts.some(receipt => receipt.registration.status !== "applied")) {
        throw new LocalTransactionDeletionError("operation_pending", "レシートの登録結果を先に確認してください。");
      }
      await this.assertNoPendingOperations(ids, receiptBefore);
      const createdAt = timestamp(this.options);
      const operationId = (this.options.makeId ?? crypto.randomUUID.bind(crypto))();
      const audit: DeletionAudit = {
        targetType: "deletion", transactionId: id, operationId, nativeSnapshot, receiptBefore,
        status: "pending", createdAt, deletedAt: null,
        undoUntil: createdAt, completedAt: null,
      };
      await this.saveAudit(audit);
      await this.finishDelete(audit);
      const completed = await this.getAudit(operationId);
      if (!completed) throw new LocalTransactionDeletionError("audit_missing", "削除結果を端末に保存できませんでした。");
      return completed;
    });
  }

  async undo(operationId: string): Promise<void> {
    const audit = await this.getAudit(operationId);
    if (!audit || audit.status !== "deleted") throw new LocalTransactionDeletionError("undo_unavailable", "元に戻せる削除記録がありません。");
    if (Date.parse(timestamp(this.options)) >= Date.parse(audit.undoUntil)) {
      throw new LocalTransactionDeletionError("undo_expired", "取り消し時間を過ぎています。");
    }
    return this.withLocks(lockKeys(audit.nativeSnapshot.map(row => row.id), audit.receiptBefore.map(receipt => receipt.id)), async () => {
      const latest = await this.getAudit(operationId);
      if (!latest || latest.status !== "deleted") throw new LocalTransactionDeletionError("undo_unavailable", "この削除はすでに取り消し済みか、処理中です。");
      if (Date.parse(timestamp(this.options)) >= Date.parse(latest.undoUntil)) {
        throw new LocalTransactionDeletionError("undo_expired", "取り消し時間を過ぎています。");
      }
      const restoring: DeletionAudit = { ...latest, status: "restoring" };
      await this.saveAudit(restoring);
      await this.finishRestore(restoring);
    });
  }

  /** Retries durable native operations after a page reload. Restoring is completed even after the undo window. */
  async recoverPending(): Promise<void> {
    const audits = await this.list();
    for (const audit of audits) {
      if (audit.status !== "pending" && audit.status !== "restoring") continue;
      await this.withLocks(lockKeys(audit.nativeSnapshot.map(row => row.id), audit.receiptBefore.map(receipt => receipt.id)), async () => {
        const current = await this.getAudit(audit.operationId);
        if (current?.status === "pending") await this.finishDelete(current);
        else if (current?.status === "restoring") await this.finishRestore(current);
      });
    }
  }

  private async assertNoPendingOperations(ids: Set<string>, receipts: LocalReceipt[]): Promise<void> {
    const linkedReceiptIds = new Set(receipts.map(receipt => receipt.id));
    const audits = await this.repository.list<Record<string, unknown>>(AUDIT_KIND);
    for (const { value } of audits) {
      if (value?.targetType === "transaction" && value.status === "pending" && typeof value.transactionId === "string" && ids.has(value.transactionId)) {
        throw new LocalTransactionDeletionError("operation_pending", "この取引は別の変更を確認中です。画面を更新してから再試行してください。");
      }
      if (value?.targetType === "receipt" && value.status === "pending" && typeof value.receiptId === "string" && linkedReceiptIds.has(value.receiptId)) {
        throw new LocalTransactionDeletionError("operation_pending", "このレシートは別の変更を確認中です。画面を更新してから再試行してください。");
      }
      if (value?.targetType === "deletion" && ["pending", "restoring"].includes(String(value.status)) &&
        typeof value.transactionId === "string" && ids.has(value.transactionId)) {
        throw new LocalTransactionDeletionError("operation_pending", "この取引の削除または復元結果を確認中です。画面を更新してから再試行してください。");
      }
    }
    const editorDrafts = await this.repository.list<{ manualTransactionId?: string | null; manualStatus?: string }>("category-state");
    if (editorDrafts.some(({ value }) => value.manualTransactionId != null && ids.has(value.manualTransactionId) &&
      ["processing", "failed"].includes(value.manualStatus ?? "draft"))) {
      throw new LocalTransactionDeletionError("operation_pending", "この取引は別の画面で編集中です。変更の保存結果を確認してから再試行してください。");
    }
    const resolutions = await this.repository.list<{ status?: string; actualTransactionId?: string | null; receiptId?: string | null }>("reconciliation-resolution");
    if (resolutions.some(({ value }) => ["pending", "processing", "failed"].includes(value.status ?? "") &&
      ((value.actualTransactionId != null && ids.has(value.actualTransactionId)) || (value.receiptId != null && linkedReceiptIds.has(value.receiptId))))) {
      throw new LocalTransactionDeletionError("operation_pending", "照合の変更結果を先に確認してください。");
    }
  }

  private async finishDelete(audit: DeletionAudit): Promise<void> {
    await this.ledger.deleteTransactionTree(audit.nativeSnapshot);
    await this.ledger.skipDeletedScheduleOccurrences?.(audit.nativeSnapshot);
    const deletedAt = timestamp(this.options);
    const completed: DeletionAudit = { ...audit, status: "deleted", deletedAt, undoUntil: new Date(Date.parse(deletedAt) + UNDO_WINDOW_MS).toISOString(), completedAt: deletedAt };
    const receiptRecords: LocalDataRecord[] = audit.receiptBefore.map(receipt => {
      const updated: LocalReceipt = { ...receipt, updatedAt: deletedAt, registration: { ...receipt.registration, status: "deleted", lastError: null } };
      return { id: receipt.id, kind: RECEIPT_KIND, value: updated, updatedAt: deletedAt };
    });
    await this.repository.putRecords([...receiptRecords, this.auditRecord(completed, deletedAt)]);
  }

  private async finishRestore(audit: DeletionAudit): Promise<void> {
    await this.ledger.restoreTransactionTree(audit.nativeSnapshot);
    const completedAt = timestamp(this.options);
    const restored: DeletionAudit = { ...audit, status: "restored", completedAt };
    const receiptRecords: LocalDataRecord[] = audit.receiptBefore.map(receipt => ({
      id: receipt.id, kind: RECEIPT_KIND, value: receipt, updatedAt: receipt.updatedAt,
    }));
    await this.repository.putRecords([...receiptRecords, this.auditRecord(restored, completedAt)]);
  }

  private async requireTree(id: string): Promise<NativeTransactionSnapshot[]> {
    const tree = await this.ledger.getTransactionTree(id);
    if (!tree.length || !tree.some(row => row.id === id)) throw new LocalTransactionDeletionError("transaction_missing", "削除する取引を見つけられませんでした。");
    return tree;
  }

  private async getAudit(operationId: string): Promise<DeletionAudit | null> {
    const record = await this.repository.get<DeletionAudit>(deletionAuditId(operationId));
    return record?.kind === AUDIT_KIND && record.value?.targetType === "deletion" ? record.value : null;
  }

  private saveAudit(audit: DeletionAudit): Promise<void> {
    return this.repository.put(this.auditRecord(audit, timestamp(this.options)));
  }

  private auditRecord(audit: DeletionAudit, updatedAt: string): LocalDataRecord<DeletionAudit> {
    return { id: deletionAuditId(audit.operationId), kind: AUDIT_KIND, value: audit, updatedAt };
  }

  private withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    if (this.options.withLock) return this.options.withLock(keys, operation);
    if (typeof navigator === "undefined" || !navigator.locks) {
      throw new LocalTransactionDeletionError("lock_unavailable", "この端末では安全に取引を変更できません。対応ブラウザーで再試行してください。");
    }
    const acquire = (index: number): Promise<T> => index >= keys.length
      ? operation()
      : navigator.locks.request(keys[index]!, { mode: "exclusive" }, () => acquire(index + 1)) as unknown as Promise<T>;
    return acquire(0);
  }
}
