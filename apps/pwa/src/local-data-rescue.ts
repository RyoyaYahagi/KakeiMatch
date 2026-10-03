import { LOCAL_DATABASE_NAME, LOCAL_PROFILE_KEY } from '../../../src/lib/local-data';

export const LOCAL_RESCUE_LIMITS = {
  maxRecords: 10_000,
  maxTotalRecordBytes: 32 * 1024 * 1024,
  maxBlobBytes: 32 * 1024 * 1024,
  maxTotalBlobBytes: 64 * 1024 * 1024,
  blobChunkBytes: 1024 * 1024,
} as const;

interface RescueRecord {
  id: string;
  kind: string;
  value: unknown;
  updatedAt: string;
}

interface RescueBlob {
  id: string;
  ownerKind: string;
  ownerId: string;
  contentType: string;
  createdAt: string;
  size: number;
  chunksBase64: string[];
}

export interface LocalDataRescueFile {
  format: 'kakeimatch-local-rescue';
  version: 1;
  exportedAt: string;
  manifest: {
    scope: string;
    includes: string[];
    excludes: string[];
    warning: string;
    skippedSensitiveRecords: number;
  };
  records: RescueRecord[];
  blobs: RescueBlob[];
}

function containsCryptoKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  return Object.values(value).some(child => containsCryptoKey(child, seen));
}

function openExistingDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let missing = false;
    let settled = false;
    const request = factory.open(LOCAL_DATABASE_NAME);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onupgradeneeded = event => {
      // Calling open without a version is important: if the database is absent,
      // abort the implicit v1 creation instead of leaving an empty database.
      if ((event as IDBVersionChangeEvent).oldVersion === 0) {
        missing = true;
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      if (missing) {
        request.result.close();
        fail(new Error('既存の端末内データベースが見つかりません。'));
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => fail(missing
      ? new Error('既存の端末内データベースが見つかりません。')
      : request.error ?? new Error('端末内データベースを読み取れませんでした。'));
    request.onblocked = () => fail(new Error('別の画面が端末内データベースを使用しています。ほかの画面を閉じて再試行してください。'));
  });
}

function readByProfile<T>(store: IDBObjectStore, profileId: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!store.indexNames.contains('profileId')) {
      reject(new Error('既存のデータ構造を読み取れません。アプリを更新して再試行してください。'));
      return;
    }
    const request = store.index('profileId').getAll(profileId, LOCAL_RESCUE_LIMITS.maxRecords + 1);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error('端末内データを読み取れませんでした。'));
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const charsPerSlice = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += charsPerSlice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + charsPerSlice));
  }
  return btoa(binary);
}

async function readBlobChunks(blob: Blob, currentTotal: number): Promise<{ chunksBase64: string[]; totalBytes: number }> {
  if (blob.size > LOCAL_RESCUE_LIMITS.maxBlobBytes) throw new Error('画像・明細原本が救出できる上限（1件32 MiB）を超えています。データは変更していません。');
  if (currentTotal + blob.size > LOCAL_RESCUE_LIMITS.maxTotalBlobBytes) throw new Error('原本の合計が救出できる上限（64 MiB）を超えています。データは変更していません。');
  const chunksBase64: string[] = [];
  for (let offset = 0; offset < blob.size; offset += LOCAL_RESCUE_LIMITS.blobChunkBytes) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + LOCAL_RESCUE_LIMITS.blobChunkBytes).arrayBuffer());
    chunksBase64.push(toBase64(bytes));
  }
  return { chunksBase64, totalBytes: currentTotal + blob.size };
}

export async function createLocalDataRescueFile(options: {
  factory?: IDBFactory;
  storage?: Pick<Storage, 'getItem'>;
  now?: () => Date;
} = {}): Promise<LocalDataRescueFile> {
  const factory = options.factory ?? indexedDB;
  const profileId = (options.storage ?? localStorage).getItem(LOCAL_PROFILE_KEY);
  if (!profileId || !/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error('端末内のプロフィールを確認できません。データは変更していません。');

  const db = await openExistingDatabase(factory);
  try {
    for (const storeName of ['records', 'blobs']) {
      if (!db.objectStoreNames.contains(storeName)) throw new Error('既存のデータ構造を読み取れません。アプリを更新して再試行してください。');
    }
    const tx = db.transaction(['records', 'blobs'], 'readonly');
    const transactionDone = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('端末内データの読み取りに失敗しました。'));
      tx.onabort = () => reject(tx.error ?? new Error('端末内データの読み取りに失敗しました。'));
    });
    const recordsPromise = readByProfile<Record<string, unknown>>(tx.objectStore('records'), profileId);
    const blobsPromise = readByProfile<Record<string, unknown>>(tx.objectStore('blobs'), profileId);
    const [storedRecords, storedBlobs] = await Promise.all([recordsPromise, blobsPromise, transactionDone]);
    if (storedRecords.length + storedBlobs.length > LOCAL_RESCUE_LIMITS.maxRecords) throw new Error('記録件数が救出できる上限（合計10,000件）を超えています。データは変更していません。');

    const recordBytes = new TextEncoder().encode(JSON.stringify(storedRecords)).byteLength;
    if (recordBytes > LOCAL_RESCUE_LIMITS.maxTotalRecordBytes) throw new Error('端末記録の合計が救出できる上限（32 MiB）を超えています。データは変更していません。');

    const records: RescueRecord[] = [];
    let skippedSensitiveRecords = 0;
    for (const row of storedRecords) {
      if (row.kind === 'app-settings' || containsCryptoKey(row)) {
        skippedSensitiveRecords += 1;
        continue;
      }
      records.push({ id: String(row.id), kind: String(row.kind), value: row.value, updatedAt: String(row.updatedAt) });
    }

    let totalBytes = 0;
    const blobs: RescueBlob[] = [];
    for (const row of storedBlobs) {
      const blob = row.blob;
      if (!(blob instanceof Blob)) throw new Error('原本の形式を確認できません。データは変更していません。');
      const read = await readBlobChunks(blob, totalBytes);
      totalBytes = read.totalBytes;
      blobs.push({
        id: String(row.id), ownerKind: String(row.ownerKind), ownerId: String(row.ownerId),
        contentType: String(row.contentType), createdAt: String(row.createdAt), size: blob.size,
        chunksBase64: read.chunksBase64,
      });
    }

    return {
      format: 'kakeimatch-local-rescue',
      version: 1,
      exportedAt: (options.now ?? (() => new Date()))().toISOString(),
      manifest: {
        scope: '選択中プロフィールのKakeiMatch端末内IndexedDB。復旧用の読み取り専用救出データです。',
        includes: ['recordsストアの対象プロフィール記録（JSON化した読取量が合計32 MiB以内。設定とCryptoKeyを含む記録を除外）', 'blobsストアの対象プロフィール原本（1 MiB単位のBase64チャンク、1件32 MiB・合計64 MiB以内）'],
        excludes: ['Actual Budgetの家計簿とデータベース', 'app-settings', '画面ロック設定', 'Cloud credentials・session・AI token', '同期用CryptoKey', '別プロフィール', '他のブラウザーデータベース'],
        warning: 'これは完全な家計バックアップではありません。.kmb形式ではなく、このアプリから復元できません。Actual Budgetの家計簿を含みません。公開せず、更新後の復旧支援に限って保管してください。',
        skippedSensitiveRecords,
      },
      records,
      blobs,
    };
  } finally {
    db.close();
  }
}

export async function downloadLocalDataRescue(options: Parameters<typeof createLocalDataRescueFile>[0] = {}): Promise<void> {
  const rescue = await createLocalDataRescueFile(options);
  const payload = new Blob([JSON.stringify(rescue)], { type: 'application/json' });
  const url = URL.createObjectURL(payload);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `kakeimatch-local-rescue-${new Date().toISOString().slice(0, 10)}.kmr`;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
