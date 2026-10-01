import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDataRepository } from "./local-data";
import { LocalTransactionDeletionService, type DeletionAudit } from "../../apps/pwa/src/local-transaction-deletions";
import type { NativeTransactionSnapshot } from "./actual-browser-ledger";
import type { LocalReceipt } from "../../apps/pwa/src/local-receipts";

const time = "2026-09-30T12:00:00.000Z";
const snapshot: NativeTransactionSnapshot[] = [
  { id: "native-parent", date: "2026-09-30", amount: -1200, account: "cash", payee: "payee-synthetic", category: null, cleared: false, reconciled: false, is_parent: true, imported_id: "kakeimatch:receipt:synthetic" },
  { id: "native-child-a", date: "2026-09-30", amount: -700, account: "cash", category: "food", cleared: false, reconciled: false, is_child: true, parent_id: "native-parent" },
  { id: "native-child-b", date: "2026-09-30", amount: -500, account: "cash", category: "household", cleared: false, reconciled: false, is_child: true, parent_id: "native-parent" },
];
const transferSnapshot: NativeTransactionSnapshot[] = [
  { id: "transfer-out", date: "2026-09-30", amount: -5000, account: "cash", cleared: true, transfer_id: "transfer-in", is_parent: false, is_child: false },
  { id: "transfer-in", date: "2026-09-30", amount: 5000, account: "bank", cleared: true, transfer_id: "transfer-out", is_parent: false, is_child: false },
];
const receipt: LocalReceipt = {
  id: "receipt:synthetic", createdAt: time, updatedAt: time, image: { blobId: "receipt-image:synthetic", contentType: "image/png", sizeBytes: 8 },
  extraction: null, aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null },
  confirmedValue: { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 1200, categoryId: "food", accountId: "cash", items: [
    { id: "item-a", name: "Synthetic food", amountYen: 700, categoryId: "food" },
    { id: "item-b", name: "Synthetic soap", amountYen: 500, categoryId: "household" },
  ] },
  registration: { status: "applied", actualTransactionId: "native-parent", lastError: null },
};

async function setup(overrides: Record<string, unknown> = {}) {
  const repository = await LocalDataRepository.open(crypto.randomUUID());
  const ledger = {
    getTransactionTree: vi.fn(async () => snapshot),
    deleteTransactionTree: vi.fn(async () => undefined),
    restoreTransactionTree: vi.fn(async () => undefined),
    ...overrides,
  };
  const service = new LocalTransactionDeletionService(repository, ledger as never, {
    now: () => new Date(time), makeId: () => "operation-synthetic", withLock: async (_keys, operation) => operation(),
  });
  return { repository, ledger, service };
}

beforeEach(() => indexedDB.deleteDatabase("kakeimatch-local-data"));

describe("LocalTransactionDeletionService", () => {
  it("deletes a split tree, marks linked receipt metadata deleted, and undo restores the exact snapshots", async () => {
    const { repository, ledger, service } = await setup();
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value: receipt, updatedAt: receipt.updatedAt });
    await repository.putBlob({ id: receipt.image!.blobId, ownerKind: "receipt", ownerId: receipt.id, blob: new Blob(["synthetic image"], { type: "image/png" }), contentType: "image/png", createdAt: time });

    const audit = await service.delete("native-parent");
    expect(ledger.deleteTransactionTree).toHaveBeenCalledWith(snapshot);
    expect(audit).toMatchObject({ status: "deleted", nativeSnapshot: snapshot, receiptBefore: [receipt] });
    expect((await repository.get<LocalReceipt>(receipt.id))?.value.registration.status).toBe("deleted");
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
    expect(await service.list()).toHaveLength(1);

    await service.undo(audit.operationId);
    expect(ledger.restoreTransactionTree).toHaveBeenCalledWith(snapshot);
    expect((await repository.get<LocalReceipt>(receipt.id))?.value).toEqual(receipt);
    expect((await repository.get<DeletionAudit>(`transaction-deletion:${audit.operationId}`))?.value.status).toBe("restored");
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
  });

  it("deletes and restores both sides of a linked account transfer", async () => {
    const { ledger, service } = await setup({ getTransactionTree: vi.fn(async () => transferSnapshot) });
    const audit = await service.delete("transfer-out");
    expect(audit.nativeSnapshot).toEqual(transferSnapshot);
    expect(ledger.deleteTransactionTree).toHaveBeenCalledWith(transferSnapshot);
    await service.undo(audit.operationId);
    expect(ledger.restoreTransactionTree).toHaveBeenCalledWith(transferSnapshot);
  });

  it("locks both transfer IDs in the same order for deletion and Undo", async () => {
    const { repository, ledger } = await setup({ getTransactionTree: vi.fn(async () => transferSnapshot) });
    const keysSeen: string[][] = [];
    const service = new LocalTransactionDeletionService(repository, ledger as never, {
      now: () => new Date(time), makeId: () => "pair-lock",
      withLock: async (keys, operation) => { keysSeen.push(keys); return operation(); },
    });
    const audit = await service.delete("transfer-in");
    await service.undo(audit.operationId);
    expect(keysSeen).toEqual([
      ["kakeimatch-manual-transaction:transfer-in", "kakeimatch-manual-transaction:transfer-out"],
      ["kakeimatch-manual-transaction:transfer-in", "kakeimatch-manual-transaction:transfer-out"],
    ]);
  });

  it("rejects undo after ten seconds but finishes an already-started restore during recovery", async () => {
    const { repository, service } = await setup();
    const audit = await service.delete("native-parent");
    const later = new LocalTransactionDeletionService(repository, {
      getTransactionTree: async () => snapshot, deleteTransactionTree: async () => undefined, restoreTransactionTree: async () => undefined,
    }, { now: () => new Date(Date.parse(time) + 10_001), withLock: async (_keys, operation) => operation() });
    await expect(later.undo(audit.operationId)).rejects.toMatchObject({ code: "undo_expired" });
    await repository.put({ id: `transaction-deletion:${audit.operationId}`, kind: "correction-audit", value: { ...audit, status: "restoring" }, updatedAt: time });
    await later.recoverPending();
    expect((await repository.get<DeletionAudit>(`transaction-deletion:${audit.operationId}`))?.value.status).toBe("restored");
  });

  it("retains a pending intent after native failure and retries it after reload", async () => {
    const deleteTransactionTree = vi.fn().mockRejectedValueOnce(new Error("synthetic failure")).mockResolvedValueOnce(undefined);
    const { repository, ledger, service } = await setup({ deleteTransactionTree });
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value: receipt, updatedAt: time });
    await expect(service.delete("native-parent")).rejects.toBeDefined();
    expect((await repository.get<LocalReceipt>(receipt.id))?.value.registration.status).toBe("applied");
    expect((await service.list())[0]?.status).toBe("pending");
    const reopened = new LocalTransactionDeletionService(repository, ledger as never, { withLock: async (_keys, operation) => operation() });
    await reopened.recoverPending();
    expect(deleteTransactionTree).toHaveBeenCalledTimes(2);
    expect((await repository.get<LocalReceipt>(receipt.id))?.value.registration.status).toBe("deleted");
    expect((await reopened.list())[0]?.status).toBe("deleted");
  });

  it("retries native deletion idempotently if local metadata commit fails", async () => {
    const { repository, ledger, service } = await setup();
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value: receipt, updatedAt: time });
    const putRecords = repository.putRecords.bind(repository);
    let failOnce = true;
    vi.spyOn(repository, "putRecords").mockImplementation(async records => {
      if (failOnce) { failOnce = false; throw new Error("synthetic commit failure"); }
      return putRecords(records);
    });
    await expect(service.delete("native-parent")).rejects.toBeDefined();
    expect((await repository.get<LocalReceipt>(receipt.id))?.value.registration.status).toBe("applied");
    await service.recoverPending();
    expect(ledger.deleteTransactionTree).toHaveBeenCalledTimes(2);
    expect((await repository.get<LocalReceipt>(receipt.id))?.value.registration.status).toBe("deleted");
  });

  it("keeps undo intent for recovery when native restoration fails and expires in the meantime", async () => {
    const { repository, ledger, service } = await setup();
    const audit = await service.delete("native-parent");
    const restore = ledger.restoreTransactionTree as ReturnType<typeof vi.fn>;
    restore.mockRejectedValueOnce(new Error("synthetic restore failure"));
    await expect(service.undo(audit.operationId)).rejects.toBeDefined();
    expect((await service.list())[0]?.status).toBe("restoring");
    const afterExpiry = new LocalTransactionDeletionService(repository, ledger as never, { now: () => new Date(Date.parse(time) + 20_000), withLock: async (_keys, operation) => operation() });
    await afterExpiry.recoverPending();
    expect((await afterExpiry.list())[0]?.status).toBe("restored");
  });

  it("rejects a target with pending receipt edits or unresolved reconciliation operations", async () => {
    const { repository, service } = await setup();
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value: receipt, updatedAt: time });
    await repository.put({ id: `receipt-correction:${receipt.id}`, kind: "correction-audit", value: { targetType: "receipt", receiptId: receipt.id, status: "pending" }, updatedAt: time });
    await expect(service.delete("native-parent")).rejects.toMatchObject({ code: "operation_pending" });
    await repository.delete(`receipt-correction:${receipt.id}`);
    await repository.put({ id: "transaction-draft", kind: "category-state", value: { manualTransactionId: "native-child-b", manualStatus: "processing" }, updatedAt: time });
    await expect(service.delete("native-parent")).rejects.toMatchObject({ code: "operation_pending" });
    await repository.delete("transaction-draft");
    await repository.put({ id: "resolution-synthetic", kind: "reconciliation-resolution", value: { status: "failed", actualTransactionId: "native-child-a", receiptId: null }, updatedAt: time });
    await expect(service.delete("native-parent")).rejects.toMatchObject({ code: "operation_pending" });
  });
});
