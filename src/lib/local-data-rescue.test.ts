import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { createLocalDataRescueFile } from '../../apps/pwa/src/local-data-rescue';

const profileId = '00000000-0000-4000-8000-000000000001';
const storage = { getItem: () => profileId };

function open(factory: IDBFactory, version: number, seed?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open('kakeimatch-local-data', version);
    request.onupgradeneeded = () => seed?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedFutureDatabase(factory: IDBFactory): Promise<void> {
  const db = await open(factory, 3, database => {
    for (const name of ['records', 'blobs']) database.createObjectStore(name, { keyPath: 'key' }).createIndex('profileId', 'profileId');
    database.createObjectStore('unrelated-credentials');
  });
  const tx = db.transaction(['records', 'blobs', 'unrelated-credentials'], 'readwrite');
  tx.objectStore('records').put({
    key: `${profileId}\0kept`, profileId, id: 'kept', kind: 'receipt-metadata',
    value: { merchant: 'Synthetic Market' }, updatedAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('records').put({
    key: `${profileId}\0settings`, profileId, id: 'settings', kind: 'app-settings',
    value: { cloudToken: 'synthetic-secret' }, updatedAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('records').put({
    key: `${profileId}\0sync-session`, profileId, id: 'sync-session', kind: 'sync-session',
    value: { token: 'synthetic-future-cloud-secret' }, updatedAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('records').put({
    key: `other\0foreign`, profileId: 'other', id: 'foreign', kind: 'receipt-metadata',
    value: { merchant: 'Other profile' }, updatedAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('blobs').put({
    key: `${profileId}\0image`, profileId, id: 'image', ownerKind: 'receipt', ownerId: 'kept',
    blob: new Blob(['synthetic image payload'], { type: 'image/jpeg' }), contentType: 'image/jpeg', createdAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('blobs').put({
    key: `${profileId}\0sync-attachment`, profileId, id: 'sync-attachment', ownerKind: 'sync-session', ownerId: 'sync-session',
    blob: new Blob(['synthetic future secret payload']), contentType: 'application/octet-stream', createdAt: '2026-09-30T00:00:00.000Z',
  });
  tx.objectStore('unrelated-credentials').put({ token: 'must-not-export' }, 'credential');
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  db.close();
}

afterEach(() => {
  indexedDB.deleteDatabase('kakeimatch-local-data');
});

describe('createLocalDataRescueFile', () => {
  it('reads only known stores and the active profile without downgrading a future schema', async () => {
    const factory = new IDBFactory();
    await seedFutureDatabase(factory);
    const file = await createLocalDataRescueFile({ factory, storage, now: () => new Date('2026-10-03T00:00:00.000Z') });
    expect(file.format).toBe('kakeimatch-local-rescue');
    expect(file.manifest.warning).toContain('完全な家計バックアップではありません');
    expect(file.manifest.excludes).toContain('Actual Budgetの家計簿とデータベース');
    expect(file.records.map(row => row.id)).toEqual(['kept']);
    expect(file.manifest.skippedSensitiveRecords).toBe(1);
    expect(file.manifest.skippedUnknownRecords).toBe(1);
    expect(file.manifest.skippedUnknownBlobs).toBe(1);
    expect(file.blobs).toHaveLength(1);
    expect(file.blobs[0]?.chunksBase64).toEqual([Buffer.from('synthetic image payload').toString('base64')]);
    expect(JSON.stringify(file)).not.toContain('synthetic-future-cloud-secret');
    expect(JSON.stringify(file)).not.toContain('synthetic future secret payload');
    expect(file.manifest.excludes).toContain('未対応のrecord kindとblob owner kind');

    const reopened = await open(factory, 3);
    expect(reopened.version).toBe(3);
    expect(reopened.objectStoreNames.contains('unrelated-credentials')).toBe(true);
    reopened.close();
  });

  it('does not create the database when no household database exists', async () => {
    const factory = new IDBFactory();
    await expect(createLocalDataRescueFile({ factory, storage })).rejects.toThrow('既存の端末内データベースが見つかりません');
    let createdVersion: number | undefined;
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('kakeimatch-local-data', 1);
      request.onupgradeneeded = event => { createdVersion = (event as IDBVersionChangeEvent).oldVersion; request.transaction?.abort(); };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => request.error?.name === 'AbortError' ? resolve() : reject(request.error);
    });
    expect(createdVersion).toBe(0);
  });

  it('rejects oversized original blobs and never returns a partial rescue', async () => {
    const factory = new IDBFactory();
    const db = await open(factory, 2, database => {
      for (const name of ['records', 'blobs']) database.createObjectStore(name, { keyPath: 'key' }).createIndex('profileId', 'profileId');
    });
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({
      key: `${profileId}\0large`, profileId, id: 'large', ownerKind: 'receipt', ownerId: 'kept',
      blob: new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]), contentType: 'image/jpeg', createdAt: '2026-09-30T00:00:00.000Z',
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
    await expect(createLocalDataRescueFile({ factory, storage })).rejects.toThrow('上限（1件32 MiB）');
  });
});
