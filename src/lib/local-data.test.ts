import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import "fake-indexeddb/auto";
import {
  LocalDataRepository,
  migrateLocalDataBackup,
  type LocalDataBackupV1,
} from "./local-data";

const openRepositories: LocalDataRepository[] = [];

async function open(profileId: string, factory: IDBFactory): Promise<LocalDataRepository> {
  const repository = await LocalDataRepository.open(profileId, factory);
  openRepositories.push(repository);
  return repository;
}

afterEach(() => {
  openRepositories.splice(0).forEach((repository) => repository.close());
});

describe("LocalDataRepository", () => {
  it("migrates v1 serialized records and restores records plus private blobs", async () => {
    const factory = new IDBFactory();
    const source = await open("profile-a", factory);
    const legacy: LocalDataBackupV1 = {
      format: "kakeimatch-local-data",
      schemaVersion: 1,
      exportedAt: "2026-09-30T00:00:00.000Z",
      entries: [{ id: "receipt-1", kind: "receipt-metadata", value: { merchant: "人工店舗" } }],
      blobs: [{
        id: "blob-1", ownerKind: "receipt", ownerId: "receipt-1", blob: new Blob(["synthetic receipt"], { type: "image/jpeg" }),
        contentType: "image/jpeg", createdAt: "2026-09-30T00:00:00.000Z",
      }],
    };

    const migrated = migrateLocalDataBackup(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.records[0]?.updatedAt).toBe(legacy.exportedAt);
    await source.restore(legacy);

    const restored = await source.serialize();
    expect(restored.records).toEqual(migrated.records);
    expect(await restored.blobs[0]?.blob.text()).toBe("synthetic receipt");
  });

  it("isolates profiles and removes an artifact's metadata and blob together", async () => {
    const factory = new IDBFactory();
    const first = await open("profile-a", factory);
    const second = await open("profile-b", factory);
    await first.put({ id: "receipt-1", kind: "receipt-metadata", value: { merchant: "人工店舗" }, updatedAt: "2026-09-30T00:00:00.000Z" });
    await first.putBlob({
      id: "blob-1", ownerKind: "receipt", ownerId: "receipt-1", blob: new Blob(["synthetic image"]),
      contentType: "image/jpeg", createdAt: "2026-09-30T00:00:00.000Z",
    });

    expect(await second.get("receipt-1")).toBeNull();
    expect(await second.getBlob("blob-1")).toBeNull();
    await first.delete("receipt-1");
    expect(await first.get("receipt-1")).toBeNull();
    expect(await first.getBlob("blob-1")).toBeNull();
  });

  it("replaces the profile snapshot on restore while preserving other profiles", async () => {
    const factory = new IDBFactory();
    const first = await open("profile-a", factory);
    const other = await open("profile-b", factory);
    await first.put({ id: "old", kind: "app-settings", value: {}, updatedAt: "2026-09-30T00:00:00.000Z" });
    await other.put({ id: "keep", kind: "app-settings", value: {}, updatedAt: "2026-09-30T00:00:00.000Z" });
    await first.restore({
      format: "kakeimatch-local-data", schemaVersion: 2, exportedAt: "2026-09-30T00:00:00.000Z",
      records: [{ id: "new", kind: "app-settings", value: { theme: "system" }, updatedAt: "2026-09-30T00:00:00.000Z" }], blobs: [],
    });

    expect(await first.get("old")).toBeNull();
    expect(await first.get("new")).not.toBeNull();
    expect(await other.get("keep")).not.toBeNull();
  });

  it("upgrades an existing IndexedDB v1 layout without dropping saved rows", async () => {
    const factory = new IDBFactory();
    const request = factory.open("kakeimatch-local-data", 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore("records", { keyPath: "key" });
      records.createIndex("profileId", "profileId");
      const blobs = request.result.createObjectStore("blobs", { keyPath: "key" });
      blobs.createIndex("profileId", "profileId");
    };
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const seed = oldDb.transaction("records", "readwrite");
    seed.objectStore("records").put({
      id: "receipt-legacy", kind: "receipt-metadata", value: { merchant: "人工店舗" }, updatedAt: "2026-09-30T00:00:00.000Z",
      profileId: "profile-a", key: "profile-a\u0000receipt-legacy",
    });
    await new Promise<void>((resolve, reject) => {
      seed.oncomplete = () => resolve();
      seed.onerror = () => reject(seed.error);
    });
    oldDb.close();

    const upgraded = await open("profile-a", factory);
    expect(await upgraded.get("receipt-legacy")).toMatchObject({ id: "receipt-legacy", value: { merchant: "人工店舗" } });
    await upgraded.putBlob({
      id: "blob-legacy", ownerKind: "receipt", ownerId: "receipt-legacy", blob: new Blob(["image"]),
      contentType: "image/jpeg", createdAt: "2026-09-30T00:00:00.000Z",
    });
    await upgraded.delete("receipt-legacy");
    expect(await upgraded.getBlob("blob-legacy")).toBeNull();
  });

  it("turns QuotaExceededError into an explicit storage failure", async () => {
    const repository = await open("profile-a", new IDBFactory());
    const write = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("synthetic quota limit", "QuotaExceededError");
    });

    await expect(repository.put({ id: "full", kind: "receipt-metadata", value: {}, updatedAt: "2026-09-30T00:00:00.000Z" }))
      .rejects.toMatchObject({ name: "LocalDataStorageError", message: expect.stringContaining("容量が不足") });
    write.mockRestore();
  });
});
