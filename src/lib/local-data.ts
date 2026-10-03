const DATABASE_NAME = "kakeimatch-local-data";
// IndexedDB layout version; independent of the serialized backup schema below.
export const LOCAL_DATABASE_VERSION = 2;
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
  | "account-metadata"
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
  constructor(message: string, readonly cause: unknown, readonly code: 'storage_unavailable' | 'migration_failed' | 'future_schema' | 'storage_blocked' | 'stale_profile' = 'storage_unavailable') {
    super(message);
    this.name = "LocalDataStorageError";
  }
}

/** Another tab switched the active household; this tab must reload before writing. */
export class StaleHouseholdProfileError extends LocalDataStorageError {
  constructor() {
    super("別の画面で家計データが切り替わりました。このページを再読み込みしてから操作してください。変更内容は保存されていません。", null, 'stale_profile');
    this.name = "StaleHouseholdProfileError";
  }
}

/**
 * Runs one write. `recordIds` names the records a write touches; `null` means it may touch
 * any household data (blobs, bulk restore, cascading deletes). Used for device sync bookkeeping.
 */
export type LocalWriteGate = <T>(recordIds: readonly string[] | null, write: () => Promise<T>) => Promise<T>;
const ungated: LocalWriteGate = (_recordIds, write) => write();

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
  if (error instanceof Error && error.name === "InvalidStateError") {
    return new LocalDataStorageError("別の画面で端末内データが更新されました。この画面を再読み込みしてから操作してください。", error);
  }
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
  return ["receipt-metadata", "receipt-extraction", "category-state", "merchant-mapping", "statement-import", "statement-transaction", "reconciliation-run", "reconciliation-result", "reconciliation-resolution", "correction-audit", "account-metadata", "app-settings"].includes(kind);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Each step runs in the same versionchange transaction; abort rolls back data and layout. */
function migrateDatabase(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (oldVersion < 0 || oldVersion > LOCAL_DATABASE_VERSION) throw new Error("Unsupported database version");
  if (oldVersion === 0) {
    for (const name of [RECORDS_STORE, BLOBS_STORE]) {
      const store = database.createObjectStore(name, { keyPath: "key" });
      store.createIndex("profileId", "profileId", { unique: false });
    }
  }
  if (oldVersion < 2) {
    const blobs = transaction.objectStore(BLOBS_STORE);
    if (!blobs.indexNames.contains("owner")) {
      blobs.createIndex("owner", ["profileId", "ownerKind", "ownerId"], { unique: false });
    }
  }
  validateDatabase(database, transaction);
}

function validateDatabase(database: IDBDatabase, transaction: IDBTransaction): void {
  for (const name of [RECORDS_STORE, BLOBS_STORE]) {
    if (!database.objectStoreNames.contains(name)) throw new Error("Missing local data store");
    const store = transaction.objectStore(name);
    if (store.keyPath !== "key" || store.autoIncrement) throw new Error("Unexpected local data key");
    const profile = store.index("profileId");
    if (profile.keyPath !== "profileId" || profile.unique || profile.multiEntry) throw new Error("Unexpected profile index");
  }
  const owner = transaction.objectStore(BLOBS_STORE).index("owner");
  if (JSON.stringify(owner.keyPath) !== JSON.stringify(["profileId", "ownerKind", "ownerId"]) || owner.unique || owner.multiEntry) {
    throw new Error("Unexpected blob owner index");
  }
}

export class LocalDataRepository {
  private constructor(private readonly database: IDBDatabase, readonly profileId: string, private readonly gate: LocalWriteGate) {}

  static async open(profileId = getOrCreateLocalProfileId(), factory: IDBFactory = indexedDB, options: { writeGate?: LocalWriteGate } = {}): Promise<LocalDataRepository> {
    try {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DATABASE_NAME, LOCAL_DATABASE_VERSION);
        let failure: LocalDataStorageError | null = null;
        request.onupgradeneeded = (event) => {
          const transaction = request.transaction!;
          // A blocked open cannot be cancelled. Abort if it later starts upgrading.
          if (failure) { transaction.abort(); return; }
          try {
            migrateDatabase(request.result, transaction, event.oldVersion);
          } catch (error) {
            failure = new LocalDataStorageError("端末内データの更新に失敗しました。更新前のデータは保持されています。他の画面を閉じ、再読み込みしてください。", error, 'migration_failed');
            transaction.abort();
          }
        };
        request.onblocked = () => {
          failure = new LocalDataStorageError("別の画面が端末内データを使用しています。このアプリの他の画面を閉じ、再読み込みしてください。", null, 'storage_blocked');
          reject(failure);
        };
        request.onerror = () => {
          if (request.error?.name === "VersionError") {
            reject(new LocalDataStorageError("この画面より新しい版の端末内データがあります。アプリを更新して再読み込みしてください。保存済みデータは削除しないでください。", request.error, 'future_schema'));
          } else {
            reject(failure ?? new LocalDataStorageError("端末内データを開けませんでした。保存済みデータは削除せず、再読み込みしてください。", request.error));
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (failure) { db.close(); return; }
          try {
            validateDatabase(db, db.transaction([RECORDS_STORE, BLOBS_STORE]));
            db.onversionchange = () => db.close();
            resolve(db);
          } catch (error) {
            db.close();
            reject(new LocalDataStorageError("端末内データの構造を確認できませんでした。保存済みデータは削除せず、アプリを更新して再読み込みしてください。", error));
          }
        };
      });
      return new LocalDataRepository(database, profileId, options.writeGate ?? ungated);
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Writes a receipt draft only while its receipt still exists in the same profile. */
  async putIfRecordExists<T>(record: LocalDataRecord<T>, requiredRecordId: string): Promise<boolean> {
    return this.gate([record.id], () => this.putIfRecordExistsNow(record, requiredRecordId));
  }

  private async putIfRecordExistsNow<T>(record: LocalDataRecord<T>, requiredRecordId: string): Promise<boolean> {
    try {
      const transaction = this.database.transaction(RECORDS_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORDS_STORE);
      const required = store.get(toKey(this.profileId, requiredRecordId));
      let exists = false;
      required.onsuccess = () => {
        exists = required.result !== undefined;
        if (exists) store.put({ ...record, profileId: this.profileId, key: toKey(this.profileId, record.id) });
      };
      await done;
      return exists;
    } catch (error) { throw storageError(error); }
  }

  async put<T>(record: LocalDataRecord<T>): Promise<void> {
    return this.gate([record.id], () => this.putNow(record));
  }

  private async putNow<T>(record: LocalDataRecord<T>): Promise<void> {
    try {
      const transaction = this.database.transaction(RECORDS_STORE, "readwrite");
      transaction.objectStore(RECORDS_STORE).put({ ...record, profileId: this.profileId, key: toKey(this.profileId, record.id) });
      await transactionDone(transaction);
    } catch (error) { throw storageError(error); }
  }

  /** Atomically commits related metadata records in one IndexedDB transaction. */
  async putRecords(records: LocalDataRecord[]): Promise<void> {
    let ids: string[];
    try { ids = records.map((record) => record.id); } catch (error) { throw storageError(error); }
    return this.gate(ids, () => this.putRecordsNow(records));
  }

  private async putRecordsNow(records: LocalDataRecord[]): Promise<void> {
    try {
      const transaction = this.database.transaction(RECORDS_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORDS_STORE);
      try {
        for (const record of records) store.put({ ...record, profileId: this.profileId, key: toKey(this.profileId, record.id) });
      } catch (error) {
        transaction.abort();
        await done.catch(() => undefined);
        throw error;
      }
      await done;
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
    // Deleting a record also deletes the blobs it owns.
    return this.gate(null, () => this.deleteNow(id));
  }

  private async deleteNow(id: string): Promise<void> {
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
    return this.gate(null, () => this.putBlobNow(blob));
  }

  private async putBlobNow(blob: LocalBlob): Promise<void> {
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
    return this.gate(null, () => this.deleteBlobNow(id));
  }

  private async deleteBlobNow(id: string): Promise<void> {
    try {
      const transaction = this.database.transaction(BLOBS_STORE, "readwrite");
      transaction.objectStore(BLOBS_STORE).delete(toKey(this.profileId, id));
      await transactionDone(transaction);
    } catch (error) { throw storageError(error); }
  }

  /** Removes one receipt and its extraction in the same transaction as its unshared image blob. */
  async deleteReceiptData(receiptId: string, extractionId: string, draftId: string): Promise<void> {
    return this.gate(null, () => this.deleteReceiptDataNow(receiptId, extractionId, draftId));
  }

  private async deleteReceiptDataNow(receiptId: string, extractionId: string, draftId: string): Promise<void> {
    try {
      const transaction = this.database.transaction([RECORDS_STORE, BLOBS_STORE], "readwrite");
      const done = transactionDone(transaction);
      const records = transaction.objectStore(RECORDS_STORE);
      const blobs = transaction.objectStore(BLOBS_STORE);
      const profileRecords = records.index("profileId").openCursor(IDBKeyRange.only(this.profileId));
      const referencedBlobIds = new Set<string>();
      const receiptOwnersByBlobId = new Map<string, string>();
      profileRecords.onsuccess = () => {
        const cursor = profileRecords.result;
        if (cursor) {
          const row = cursor.value as StoredRecord;
          if (row.id !== receiptId) {
            collectBlobReferences(row.value, referencedBlobIds);
            if (row.kind === "receipt-metadata") {
              const image = (row.value as { image?: { blobId?: unknown } } | null)?.image;
              if (typeof image?.blobId === "string") receiptOwnersByBlobId.set(image.blobId, row.id);
            }
          }
          cursor.continue();
          return;
        }
        records.delete(toKey(this.profileId, receiptId));
        records.delete(toKey(this.profileId, extractionId));
        records.delete(toKey(this.profileId, draftId));
        records.delete(toKey(this.profileId, `category-learning:${receiptId}`));
        const owned = blobs.index("owner").openCursor(IDBKeyRange.only([this.profileId, "receipt", receiptId]));
        owned.onsuccess = () => {
          const blobCursor = owned.result;
          if (!blobCursor) return;
          const row = blobCursor.value as StoredBlob;
          if (!referencedBlobIds.has(row.id)) blobCursor.delete();
          else {
            const newOwnerId = receiptOwnersByBlobId.get(row.id);
            if (!newOwnerId) { transaction.abort(); return; }
            blobCursor.update({ ...row, ownerId: newOwnerId });
          }
          blobCursor.continue();
        };
      };
      await done;
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
    return this.gate(null, () => this.restoreNow(input));
  }

  private async restoreNow(input: LocalDataBackup): Promise<void> {
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

  /** Removes one profile's records and blobs, for discarding a staged or superseded household. */
  async clearProfile(profileId: string): Promise<void> {
    if (profileId === this.profileId) throw new Error("Use restore() to replace the open profile.");
    try {
      const transaction = this.database.transaction([RECORDS_STORE, BLOBS_STORE], "readwrite");
      const done = transactionDone(transaction);
      for (const name of [RECORDS_STORE, BLOBS_STORE]) {
        const cursorRequest = transaction.objectStore(name).index("profileId").openCursor(IDBKeyRange.only(profileId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
      }
      await done;
    } catch (error) { throw storageError(error); }
  }

  close(): void { this.database.close(); }

  private async listBlobs(): Promise<LocalBlob[]> {
    const rows = await requestResult(this.database.transaction(BLOBS_STORE).objectStore(BLOBS_STORE).index("profileId").getAll(this.profileId)) as StoredBlob[];
    return rows.map(stripBlob);
  }
}


function collectBlobReferences(value: unknown, references: Set<string>, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectBlobReferences(item, references, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "blobId" && typeof item === "string") references.add(item);
    else collectBlobReferences(item, references, seen);
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
