const DATABASE_NAME = "kakeimatch-local-data";
const DATABASE_VERSION = 2;
const RECORDS_STORE = "records";
const BLOBS_STORE = "blobs";
export const LOCAL_PROFILE_KEY = "kakeimatch.local-profile.v1";

export const LOCAL_DATA_SCHEMA_VERSION = 2;

export type LocalDataKind =
  | "receipt-metadata"
  | "receipt-extraction"
  | "category-state"
  | "merchant-mapping"
  | "statement-import"
  | "statement-transaction"
  | "reconciliation-run"
  | "reconciliation-result"
  | "reconciliation-resolution"
  | "correction-audit"
  | "app-settings";

export interface LocalDataRecord<T = unknown> {
  id: string;
  kind: LocalDataKind;
  value: T;
  updatedAt: string;
}

export interface LocalBlob {
  id: string;
  ownerKind: "receipt" | "statement-import";
  ownerId: string;
  blob: Blob;
  contentType: string;
  createdAt: string;
}

interface StoredRecord extends LocalDataRecord {
  profileId: string;
  key: string;
}

interface StoredBlob extends LocalBlob {
  profileId: string;
  key: string;
}

export interface LocalDataBackupV2 {
  format: "kakeimatch-local-data";
  schemaVersion: 2;
  exportedAt: string;
  records: LocalDataRecord[];
  blobs: LocalBlob[];
}

export interface LocalDataBackupV1 {
  format: "kakeimatch-local-data";
  schemaVersion: 1;
  exportedAt: string;
  entries: Array<{ id: string; kind: string; value: unknown; updatedAt?: string }>;
  blobs?: LocalBlob[];
}

export type LocalDataBackup = LocalDataBackupV1 | LocalDataBackupV2;

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}

export class LocalDataStorageError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "LocalDataStorageError";
  }
}

export function getOrCreateLocalProfileId(storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage): string {
  const existing = storage.getItem(LOCAL_PROFILE_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const id = crypto.randomUUID();
  storage.setItem(LOCAL_PROFILE_KEY, id);
  return id;
}

function toKey(profileId: string, id: string): string {
  return `${profileId}\u0000${id}`;
}

function storageError(error: unknown): LocalDataStorageError {
  if (error instanceof LocalDataStorageError) return error;
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return new LocalDataStorageError("端末の保存容量が不足しているため、データを保存できませんでした。空き容量を確認してから再試行してください。", error);
  }
  return new LocalDataStorageError("端末内データを保存できませんでした。変更内容は保存されていません。", error);
}

export function migrateLocalDataBackup(input: LocalDataBackup): LocalDataBackupV2 {
  if (input.format !== "kakeimatch-local-data") throw new Error("バックアップ形式が不正です。");
  if (input.schemaVersion === 2) return input;
  if (input.schemaVersion !== 1) throw new Error("対応していないバックアップschema versionです。");
  const records = input.entries.map((entry): LocalDataRecord => {
    if (!isLocalDataKind(entry.kind)) throw new Error(`未対応のデータ種別です: ${entry.kind}`);
    return { id: entry.id, kind: entry.kind, value: entry.value, updatedAt: entry.updatedAt ?? input.exportedAt };
  });
  return {
    format: "kakeimatch-local-data",
    schemaVersion: 2,
    exportedAt: input.exportedAt,
    records,
    blobs: input.blobs ?? [],
  };
}

function isLocalDataKind(kind: string): kind is LocalDataKind {
  return ["receipt-metadata", "receipt-extraction", "category-state", "merchant-mapping", "statement-import", "statement-transaction", "reconciliation-run", "reconciliation-result", "reconciliation-resolution", "correction-audit", "app-settings"].includes(kind);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class LocalDataRepository {
  private constructor(private readonly database: IDBDatabase, readonly profileId: string) {}

  static async open(profileId = getOrCreateLocalProfileId(), factory: IDBFactory = indexedDB): Promise<LocalDataRepository> {
    try {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS_STORE)) {
          const records = db.createObjectStore(RECORDS_STORE, { keyPath: "key" });
          records.createIndex("profileId", "profileId", { unique: false });
        }
        if (!db.objectStoreNames.contains(BLOBS_STORE)) {
          const blobs = db.createObjectStore(BLOBS_STORE, { keyPath: "key" });
          blobs.createIndex("profileId", "profileId", { unique: false });
        }
        const blobs = request.transaction!.objectStore(BLOBS_STORE);
        if (!blobs.indexNames.contains("owner")) blobs.createIndex("owner", ["profileId", "ownerKind", "ownerId"], { unique: false });
      };
      const database = await requestResult(request);
      database.onversionchange = () => database.close();
      return new LocalDataRepository(database, profileId);
    } catch (error) {
      throw storageError(error);
    }
  }

  async put<T>(record: LocalDataRecord<T>): Promise<void> {
    try {
      const transaction = this.database.transaction(RECORDS_STORE, "readwrite");
      transaction.objectStore(RECORDS_STORE).put({ ...record, profileId: this.profileId, key: toKey(this.profileId, record.id) });
      await transactionDone(transaction);
    } catch (error) { throw storageError(error); }
  }

  async get<T>(id: string): Promise<LocalDataRecord<T> | null> {
    try {
      const row = await requestResult(this.database.transaction(RECORDS_STORE).objectStore(RECORDS_STORE).get(toKey(this.profileId, id))) as StoredRecord | undefined;
      return row ? { id: row.id, kind: row.kind, value: row.value as T, updatedAt: row.updatedAt } : null;
    } catch (error) { throw storageError(error); }
  }

  async list<T>(kind?: LocalDataKind): Promise<Array<LocalDataRecord<T>>> {
    try {
      const rows = await requestResult(this.database.transaction(RECORDS_STORE).objectStore(RECORDS_STORE).index("profileId").getAll(this.profileId)) as StoredRecord[];
      return rows.filter((row) => !kind || row.kind === kind).map((row) => ({ id: row.id, kind: row.kind, value: row.value as T, updatedAt: row.updatedAt }));
    } catch (error) { throw storageError(error); }
  }

  async delete(id: string): Promise<void> {
    try {
      const transaction = this.database.transaction([RECORDS_STORE, BLOBS_STORE], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(RECORDS_STORE).delete(toKey(this.profileId, id));
      const owner = transaction.objectStore(BLOBS_STORE).index("owner");
      for (const ownerKind of ["receipt", "statement-import"] as const) {
        const cursorRequest = owner.openCursor(IDBKeyRange.only([this.profileId, ownerKind, id]));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
      }
      await done;
    } catch (error) { throw storageError(error); }
  }

  async putBlob(blob: LocalBlob): Promise<void> {
    try {
      const transaction = this.database.transaction(BLOBS_STORE, "readwrite");
      transaction.objectStore(BLOBS_STORE).put({ ...blob, profileId: this.profileId, key: toKey(this.profileId, blob.id) });
      await transactionDone(transaction);
    } catch (error) { throw storageError(error); }
  }

  async getBlob(id: string): Promise<LocalBlob | null> {
    try {
      const row = await requestResult(this.database.transaction(BLOBS_STORE).objectStore(BLOBS_STORE).get(toKey(this.profileId, id))) as StoredBlob | undefined;
      return row ? stripBlob(row) : null;
    } catch (error) { throw storageError(error); }
  }

  async deleteBlob(id: string): Promise<void> {
    try {
      const transaction = this.database.transaction(BLOBS_STORE, "readwrite");
      transaction.objectStore(BLOBS_STORE).delete(toKey(this.profileId, id));
      await transactionDone(transaction);
    } catch (error) { throw storageError(error); }
  }

  async estimate(): Promise<StorageEstimate> {
    try {
      if (!navigator.storage?.estimate) return { usage: null, quota: null };
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    } catch {
      return { usage: null, quota: null };
    }
  }

  async serialize(): Promise<LocalDataBackupV2> {
    try {
      const [records, blobs] = await Promise.all([this.list(), this.listBlobs()]);
      return { format: "kakeimatch-local-data", schemaVersion: 2, exportedAt: new Date().toISOString(), records, blobs };
    } catch (error) { throw storageError(error); }
  }

  async restore(input: LocalDataBackup): Promise<void> {
    const backup = migrateLocalDataBackup(input);
    if (backup.records.some((record) => !isLocalDataKind(record.kind))) throw new Error("バックアップに未対応のデータ種別があります。");
    try {
      const transaction = this.database.transaction([RECORDS_STORE, BLOBS_STORE], "readwrite");
      const done = transactionDone(transaction);
      const records = transaction.objectStore(RECORDS_STORE);
      const blobs = transaction.objectStore(BLOBS_STORE);
      let remainingCursors = 2;
      const queueReplacement = () => {
        remainingCursors -= 1;
        if (remainingCursors !== 0) return;
        // Queue writes in the last IndexedDB callback, while the transaction is active.
        for (const record of backup.records) records.put({ ...record, profileId: this.profileId, key: toKey(this.profileId, record.id) });
        for (const blob of backup.blobs) blobs.put({ ...blob, profileId: this.profileId, key: toKey(this.profileId, blob.id) });
      };
      for (const store of [records, blobs]) {
        const cursorRequest = store.index("profileId").openCursor(IDBKeyRange.only(this.profileId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else queueReplacement();
        };
      }
      await done;
    } catch (error) { throw storageError(error); }
  }

  /** Household stores only; Cloud account/session storage lives outside this database. */
  async clearAllDeviceProfiles(): Promise<void> {
    try {
      const transaction = this.database.transaction([RECORDS_STORE, BLOBS_STORE], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(RECORDS_STORE).clear();
      transaction.objectStore(BLOBS_STORE).clear();
      await done;
    } catch (error) { throw storageError(error); }
  }

  close(): void { this.database.close(); }

  private async listBlobs(): Promise<LocalBlob[]> {
    const rows = await requestResult(this.database.transaction(BLOBS_STORE).objectStore(BLOBS_STORE).index("profileId").getAll(this.profileId)) as StoredBlob[];
    return rows.map(stripBlob);
  }
}

function stripBlob(row: StoredBlob): LocalBlob {
  return { id: row.id, ownerKind: row.ownerKind, ownerId: row.ownerId, blob: row.blob, contentType: row.contentType, createdAt: row.createdAt };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}
