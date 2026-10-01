import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import "fake-indexeddb/auto";
import {
  LocalDataRepository,
  LOCAL_DATABASE_VERSION,
  migrateLocalDataBackup,
  type LocalDataBackupV1,
} from "./local-data";

const openRepositories: LocalDataRepository[] = [];

async function open(profileId: string, factory: IDBFactory): Promise<LocalDataRepository> {
  const repository = await LocalDataRepository.open(profileId, factory);
  openRepositories.push(repository);
  return repository;
}

function rawOpen(factory: IDBFactory, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const request = factory.open("kakeimatch-local-data", version);
  request.onupgradeneeded = () => upgrade?.(request.result);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedV1(factory: IDBFactory): Promise<void> {
  const db = await rawOpen(factory, 1, db => {
    for (const name of ["records", "blobs"]) {
      db.createObjectStore(name, { keyPath: "key" }).createIndex("profileId", "profileId");
    }
  });
  const transaction = db.transaction(["records", "blobs"], "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  for (const profileId of ["profile-a", "profile-b"]) {
    transaction.objectStore("records").put({
      key: `${profileId}\u0000receipt`, profileId, id: "receipt", kind: "receipt-metadata",
      value: { merchant: "人工店舗", profileId }, updatedAt: "2026-09-30T00:00:00.000Z",
    });
    transaction.objectStore("blobs").put({
      key: `${profileId}\u0000image`, profileId, id: "image", ownerKind: "receipt", ownerId: "receipt",
      blob: new Blob([`synthetic ${profileId}`]), contentType: "image/jpeg", createdAt: "2026-09-30T00:00:00.000Z",
    });
  }
  await done;
  db.close();
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it("preserves every profile and blob across v1 migration and repeated reopening", async () => {
    const factory = new IDBFactory();
    await seedV1(factory);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const profile of ["profile-a", "profile-b"]) {
        const repository = await open(profile, factory);
        expect(await repository.get("receipt")).toMatchObject({ value: { profileId: profile } });
        expect(await (await repository.getBlob("image"))?.blob.text()).toBe(`synthetic ${profile}`);
        repository.close();
      }
    }
    const db = await rawOpen(factory, LOCAL_DATABASE_VERSION);
    expect(db.version).toBe(2);
    expect(db.transaction("blobs").objectStore("blobs").indexNames.contains("owner")).toBe(true);
    db.close();
  });

  it("rolls back layout, version and data after a partially executed migration fails, then retries", async () => {
    const factory = new IDBFactory();
    await seedV1(factory);
    const createIndex = IDBObjectStore.prototype.createIndex;
    const failure = vi.spyOn(IDBObjectStore.prototype, "createIndex").mockImplementation(function (this: IDBObjectStore, ...args) {
      const index = createIndex.apply(this, args);
      this.transaction.objectStore("records").clear();
      this.clear();
      throw new Error(`synthetic migration failure after ${index.name}`);
    });
    try {
      await expect(LocalDataRepository.open("profile-a", factory)).rejects.toMatchObject({
        name: "LocalDataStorageError", message: expect.stringContaining("更新前のデータは保持"),
      });
    } finally { failure.mockRestore(); }
    const old = await rawOpen(factory, 1);
    expect(old.version).toBe(1);
    const transaction = old.transaction(["records", "blobs"]);
    expect(transaction.objectStore("blobs").indexNames.contains("owner")).toBe(false);
    const counts = ["records", "blobs"].map(name => new Promise<number>((resolve, reject) => {
      const request = transaction.objectStore(name).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
    expect(await Promise.all(counts)).toEqual([2, 2]);
    old.close();
    for (const profile of ["profile-a", "profile-b"]) {
      const repository = await open(profile, factory);
      expect(await repository.get("receipt")).toMatchObject({ value: { profileId: profile } });
      expect(await (await repository.getBlob("image"))?.blob.text()).toBe(`synthetic ${profile}`);
    }
  });

  it("rejects a future layout without changing its data or version", async () => {
    const factory = new IDBFactory();
    const repository = await open("profile-a", factory);
    await repository.put({ id: "keep", kind: "app-settings", value: { synthetic: true }, updatedAt: "2026-09-30T00:00:00.000Z" });
    repository.close();
    const future = await rawOpen(factory, LOCAL_DATABASE_VERSION + 1, db => db.createObjectStore("future"));
    future.close();
    await expect(LocalDataRepository.open("profile-a", factory)).rejects.toMatchObject({ message: expect.stringContaining("新しい版") });
    const unchanged = await rawOpen(factory, LOCAL_DATABASE_VERSION + 1);
    expect(unchanged.objectStoreNames.contains("future")).toBe(true);
    const request = unchanged.transaction("records").objectStore("records").get("profile-a\u0000keep");
    const row = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
    expect(row).toMatchObject({ id: "keep", value: { synthetic: true } });
    unchanged.close();
  });

  it("rejects blocked upgrades promptly and aborts the abandoned open after the old tab closes", async () => {
    const factory = new IDBFactory();
    await seedV1(factory);
    const old = await rawOpen(factory, 1);
    try {
      await expect(LocalDataRepository.open("profile-a", factory)).rejects.toMatchObject({ message: expect.stringContaining("他の画面を閉じ") });
    } finally { old.close(); }
    // Queued behind the abandoned upgrade: succeeds only if it rolled back and released its connection.
    const unchanged = await rawOpen(factory, 1);
    expect(unchanged.version).toBe(1);
    unchanged.close();
    const retry = await open("profile-a", factory);
    expect(await retry.get("receipt")).not.toBeNull();
  });

  it("asks a stale connection to reload after another tab upgrades", async () => {
    const factory = new IDBFactory();
    const repository = await open("profile-a", factory);
    const next = await rawOpen(factory, LOCAL_DATABASE_VERSION + 1);
    await expect(repository.get("receipt")).rejects.toMatchObject({ message: expect.stringContaining("再読み込み") });
    next.close();
  });

  it("rejects a malformed current layout without recreating missing stores", async () => {
    const factory = new IDBFactory();
    const malformed = await rawOpen(factory, LOCAL_DATABASE_VERSION, db => db.createObjectStore("records", { keyPath: "key" }));
    malformed.close();
    await expect(LocalDataRepository.open("profile-a", factory)).rejects.toMatchObject({ message: expect.stringContaining("構造を確認できません") });
    const unchanged = await rawOpen(factory, LOCAL_DATABASE_VERSION);
    expect(Array.from(unchanged.objectStoreNames)).toEqual(["records"]);
    unchanged.close();
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
