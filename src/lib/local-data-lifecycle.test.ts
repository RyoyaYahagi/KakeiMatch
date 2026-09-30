import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalDataRepository } from "./local-data";
import {
  cleanupReceiptImages,
  cleanupStatementCsv,
  getCleanupSummary,
  getStorageStatus,
  shouldRemindLocalExport,
} from "../../apps/pwa/src/local-data-lifecycle";
import type { LocalReceipt } from "../../apps/pwa/src/local-receipts";
import type { LocalStatement } from "../../apps/pwa/src/local-statements";

const opened: LocalDataRepository[] = [];

async function open(profileId = "profile-a"): Promise<LocalDataRepository> {
  const repository = await LocalDataRepository.open(profileId, new IDBFactory());
  opened.push(repository);
  return repository;
}

afterEach(() => {
  opened.splice(0).forEach((repository) => repository.close());
  vi.unstubAllGlobals();
});

function receipt(id: string, status: LocalReceipt["registration"]["status"], blobId: string): LocalReceipt {
  return {
    id, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    image: { blobId, contentType: "image/jpeg", sizeBytes: 8 },
    extraction: null,
    aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null },
    confirmedValue: { merchant: "人工店舗", purchasedDate: "2026-09-01", purchasedTime: null, totalAmountYen: 800, categoryId: "food", accountId: "checking" },
    registration: { status, actualTransactionId: status === "applied" ? "actual-tx-1" : null, lastError: null },
  };
}

function statement(): LocalStatement {
  return {
    id: "statement-row-1", importId: "import-1", provider: "paypay", externalId: "source-1", sourceFingerprint: "fingerprint-1", usedTime: null,
    duplicateOrdinal: 0, kind: "purchase", usedDate: "2026-09-01", postedDate: null, merchant: "人工店舗",
    amountYen: 800, paymentMethod: null,
  };
}

describe("local data lifecycle", () => {
  it("cleans only safe raw artifacts and preserves canonical and reconciliation records", async () => {
    const repository = await open();
    const applied = receipt("receipt-applied", "applied", "receipt-image-applied");
    const pending = receipt("receipt-pending", "pending", "receipt-image-pending");
    const failed = receipt("receipt-failed", "failed", "receipt-image-failed");
    for (const item of [applied, pending, failed]) {
      await repository.put({ id: item.id, kind: "receipt-metadata", value: item, updatedAt: item.updatedAt });
      await repository.putBlob({ id: item.image!.blobId, ownerKind: "receipt", ownerId: item.id, blob: new Blob([item.id]), contentType: "image/jpeg", createdAt: item.createdAt });
    }

    const row = statement();
    const importMetadata = {
      provider: "paypay", fileHash: "a".repeat(64), encoding: "utf-8", headerSignature: "date,amount,merchant",
      totalRows: 1, excludedRows: 0, duplicateRowsInFile: 0, createdAt: "2026-09-01T00:00:00.000Z",
    } as const;
    await repository.put({ id: "import-1", kind: "statement-import", value: importMetadata, updatedAt: importMetadata.createdAt });
    await repository.put({ id: row.id, kind: "statement-transaction", value: row, updatedAt: importMetadata.createdAt });
    await repository.putBlob({ id: "statement-source:import-1", ownerKind: "statement-import", ownerId: "import-1", blob: new Blob(["synthetic csv"]), contentType: "text/csv", createdAt: importMetadata.createdAt });
    const resolution = { id: "resolution-1", status: "applied", statementId: row.id, receiptId: applied.id };
    await repository.put({ id: resolution.id, kind: "reconciliation-resolution", value: resolution, updatedAt: importMetadata.createdAt });

    expect(await getCleanupSummary(repository)).toEqual({
      receipts: { count: 1, bytes: applied.id.length },
      statements: { count: 1, bytes: "synthetic csv".length },
      total: { count: 2, bytes: applied.id.length + "synthetic csv".length },
    });
    expect(await cleanupReceiptImages(repository)).toEqual({ deletedCount: 1, deletedBytes: applied.id.length });
    expect(await cleanupStatementCsv(repository)).toEqual({ deletedCount: 1, deletedBytes: "synthetic csv".length });

    expect(await repository.getBlob(applied.image!.blobId)).toBeNull();
    expect(await repository.getBlob(pending.image!.blobId)).not.toBeNull();
    expect(await repository.getBlob(failed.image!.blobId)).not.toBeNull();
    expect((await repository.get<LocalReceipt>(applied.id))?.value).toEqual(applied);
    expect((await repository.get<LocalStatement>(row.id))?.value).toEqual(row);
    expect((await repository.get("import-1"))?.value).toEqual(importMetadata);
    expect((await repository.get(resolution.id))?.value).toEqual(resolution);
  });

  it("keeps a receipt without confirmed values and a CSV without canonical rows", async () => {
    const repository = await open();
    const unconfirmed = { ...receipt("receipt-unconfirmed", "applied", "receipt-unconfirmed-blob"), confirmedValue: null };
    await repository.put({ id: unconfirmed.id, kind: "receipt-metadata", value: unconfirmed, updatedAt: unconfirmed.updatedAt });
    await repository.putBlob({ id: "receipt-unconfirmed-blob", ownerKind: "receipt", ownerId: unconfirmed.id, blob: new Blob(["image"]), contentType: "image/jpeg", createdAt: unconfirmed.createdAt });
    const metadata = {
      provider: "paypay", fileHash: "b".repeat(64), encoding: "utf-8", headerSignature: "date,amount,merchant",
      totalRows: 1, excludedRows: 0, duplicateRowsInFile: 0, createdAt: "2026-09-01T00:00:00.000Z",
    };
    await repository.put({ id: "import-empty", kind: "statement-import", value: metadata, updatedAt: metadata.createdAt });
    await repository.putBlob({ id: "statement-source:import-empty", ownerKind: "statement-import", ownerId: "import-empty", blob: new Blob(["csv"]), contentType: "text/csv", createdAt: metadata.createdAt });
    const partialMetadata = { ...metadata, fileHash: "c".repeat(64), totalRows: 2 };
    const partialRow = { ...statement(), id: "statement-row-partial", importId: "import-partial" };
    await repository.put({ id: "import-partial", kind: "statement-import", value: partialMetadata, updatedAt: metadata.createdAt });
    await repository.put({ id: partialRow.id, kind: "statement-transaction", value: partialRow, updatedAt: metadata.createdAt });
    await repository.putBlob({ id: "statement-source:import-partial", ownerKind: "statement-import", ownerId: "import-partial", blob: new Blob(["partial csv"]), contentType: "text/csv", createdAt: metadata.createdAt });

    expect(await getCleanupSummary(repository)).toEqual({ receipts: { count: 0, bytes: 0 }, statements: { count: 0, bytes: 0 }, total: { count: 0, bytes: 0 } });
    expect(await cleanupReceiptImages(repository)).toEqual({ deletedCount: 0, deletedBytes: 0 });
    expect(await cleanupStatementCsv(repository)).toEqual({ deletedCount: 0, deletedBytes: 0 });
    expect(await repository.getBlob("receipt-unconfirmed-blob")).not.toBeNull();
    expect(await repository.getBlob("statement-source:import-empty")).not.toBeNull();
    expect(await repository.getBlob("statement-source:import-partial")).not.toBeNull();
  });

  it("treats storage persistence APIs as optional and false as an ordinary result", async () => {
    vi.stubGlobal("navigator", {});
    expect(await getStorageStatus({ requestPersistence: true })).toEqual({ usage: null, quota: null, persisted: null, persistenceRequested: null });

    vi.stubGlobal("navigator", { storage: {
      estimate: async () => ({ usage: 120, quota: 1000 }),
      persist: async () => false,
      persisted: async () => false,
    } });
    expect(await getStorageStatus({ requestPersistence: true })).toEqual({ usage: 120, quota: 1000, persisted: false, persistenceRequested: false });

    vi.stubGlobal("navigator", { storage: {
      estimate: async () => { throw new Error("unavailable"); },
      persisted: async () => { throw new Error("unavailable"); },
    } });
    expect(await getStorageStatus()).toEqual({ usage: null, quota: null, persisted: null, persistenceRequested: null });
  });

  it("reminds from the generated export timestamp after thirty days", () => {
    const now = new Date("2026-09-30T00:00:00.000Z");
    expect(shouldRemindLocalExport(null, now)).toBe(true);
    expect(shouldRemindLocalExport("2026-08-31T00:00:00.000Z", now)).toBe(true);
    expect(shouldRemindLocalExport("2026-09-01T00:00:00.000Z", now)).toBe(false);
    expect(shouldRemindLocalExport("2026-10-01T00:00:00.000Z", now)).toBe(false);
    expect(shouldRemindLocalExport("invalid", now)).toBe(true);
  });
});
