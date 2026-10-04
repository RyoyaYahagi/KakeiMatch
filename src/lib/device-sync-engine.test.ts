import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { LocalDataRepository, LOCAL_PROFILE_KEY, type LocalDataRecord } from './local-data';
import { PREVIOUS_PROFILE_KEY } from '../../apps/pwa/src/local-backup';
import { readPortableBackup } from './local-backup-format';
import { readSyncState } from '../../apps/pwa/src/household-sync-state';
import { HouseholdWriteGuard } from '../../apps/pwa/src/household-write-guard';
import { DeviceSyncApi } from '../../apps/pwa/src/device-sync-api';
import { DeviceSyncSecretStore } from '../../apps/pwa/src/device-sync-secrets';
import { DeviceSyncEngine, ExternalStorageAuthError, ExternalStorageMissingError, type ExternalSyncStorage } from '../../apps/pwa/src/device-sync-engine';
import { handleSyncRequest, type SyncApiEnv } from '../../workers/ai-gateway/src/device-sync-api';
import { InMemorySyncStorageProvider } from '../../workers/ai-gateway/src/sync-storage-provider';

// Two synthetic devices of one user run the real sync engine against the real `/api/sync`
// handler (D1 on node:sqlite, in-memory provider). No household data leaves the process.

vi.mock('../../workers/ai-gateway/src/account-auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workers/ai-gateway/src/account-auth')>(),
  getAccountSession: vi.fn(async () => ({ user: { id: 'synthetic-user', email: '', name: '' }, session: { id: 'synthetic-session', expiresAt: new Date(0) } })),
}));

const origin = 'https://sync.example.test';
const at = '2026-10-04T00:00:00.000Z';
const migrations = ['0001_auth.sql', '0007_account_deletion.sql', '0009_device_sync.sql', '0011_sync_household_keys.sql', '0012_sync_external_storage.sql', '0013_sync_kept_versions.sql']
  .map(name => readFileSync(new URL(`../../workers/ai-gateway/migrations/${name}`, import.meta.url), 'utf8'));

function d1(sqlite: DatabaseSync) {
  type Statement = { query: string; values: SQLInputValue[] };
  const prepare = (query: string) => {
    const statement = {
      query, values: [] as SQLInputValue[],
      bind(...values: unknown[]) { statement.values = values as SQLInputValue[]; return statement; },
      async first<T>() { return (sqlite.prepare(query).get(...statement.values) as T | undefined) ?? null; },
      async all<T>() { return { results: sqlite.prepare(query).all(...statement.values) as T[] }; },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...statement.values).changes) } }; },
    };
    return statement;
  };
  return {
    prepare,
    async batch<T>(statements: unknown[]): Promise<T[]> {
      sqlite.exec('BEGIN');
      try {
        const results = (statements as Statement[]).map(s => ({ success: true, meta: { changes: Number(sqlite.prepare(s.query).run(...s.values).changes) } }));
        sqlite.exec('COMMIT');
        return results as T[];
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

let sqlite: DatabaseSync;
let env: SyncApiEnv;
let provider: InMemorySyncStorageProvider;
let dropNextPublishResponse = false;

const serverFetch: typeof fetch = async (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('origin', origin);
  // Browsers send Content-Length for Blob bodies; the handler requires it for chunks.
  if (init.body instanceof Blob) headers.set('content-length', String(init.body.size));
  const body = init.body instanceof Blob ? await init.body.arrayBuffer() : init.body;
  const response = await handleSyncRequest(new Request(`${origin}${String(input)}`, { method: init.method, headers, body }), env, { provider });
  if (dropNextPublishResponse && String(input).endsWith('/publish')) {
    dropNextPublishResponse = false;
    throw new TypeError('synthetic lost response');
  }
  return response;
};

const receipt = (id: string): LocalDataRecord => ({ id, kind: 'receipt-metadata', updatedAt: at, value: {
  id, createdAt: at, updatedAt: at, image: null, extraction: null,
  aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
  confirmedValue: { merchant: 'Synthetic Store', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 1200, categoryId: 'category', accountId: 'account' },
  registration: { status: 'applied', actualTransactionId: 'synthetic-tx', lastError: null },
} });

/** The user's Google Drive app folder, shared by both devices. Each device has its own connection. */
class FakeDrive {
  files = new Map<string, { bytes: Uint8Array; createdAt: string }>();
  failPutsAfter: number | null = null;
  connection(): ExternalSyncStorage & { connected: boolean } {
    const files = this.files;
    const shouldFail = () => this.failPutsAfter !== null && this.failPutsAfter-- <= 0;
    return {
      name: 'google-drive', connected: true,
      isConnected() { return this.connected; },
      async put(chunk) {
        if (!this.connected) throw new ExternalStorageAuthError();
        if (shouldFail()) throw new Error('synthetic drive failure');
        const ref = `drive${crypto.randomUUID().replace(/-/g, '')}`;
        files.set(ref, { bytes: new Uint8Array(await chunk.arrayBuffer()), createdAt: '2000-01-01T00:00:00.000Z' });
        return ref;
      },
      async get(ref) {
        if (!this.connected) throw new ExternalStorageAuthError();
        const file = files.get(ref);
        if (!file) throw new ExternalStorageMissingError();
        return new Blob([file.bytes.slice().buffer as ArrayBuffer]);
      },
      async delete(ref) { files.delete(ref); },
      async list() { return [...files].map(([ref, file]) => ({ ref, createdAt: file.createdAt })); },
    };
  }
}

/** One device: its own IndexedDB, localStorage, Actual stand-in and engine. */
async function device(name: string, externalStorage?: ExternalSyncStorage) {
  const factory = new IDBFactory();
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  const actual = new Map<string, Uint8Array>();
  const profileId = crypto.randomUUID();
  storage.setItem(LOCAL_PROFILE_KEY, profileId);
  actual.set('/documents', new TextEncoder().encode(`${name}-actual`));
  const secrets = new DeviceSyncSecretStore(factory);
  const open = async () => {
    const active = storage.getItem(LOCAL_PROFILE_KEY)!;
    // Writes are dated an hour back so the snapshot's quiet period has passed.
    const guard = new HouseholdWriteGuard(active, { storage, locks: undefined, now: () => new Date(Date.now() - 3_600_000) });
    const repository = await LocalDataRepository.open(active, factory, { writeGate: guard.repositoryGate });
    const dataDir = (await repository.get<{ dataDir?: string }>('settings:budget'))?.value.dataDir ?? '/documents';
    const ledger = {
      exportBackup: async () => actual.get(dataDir)!,
      restoreBackup: async (data: Uint8Array, dir: string) => { actual.set(dir, data); return `budget-${dir}`; },
      discardDataDirectory: async (dir: string) => { actual.delete(dir); },
    };
    // Exclusive household locks are not available in node; this stand-in runs one at a time.
    guard.exclusive = async <T>(operation: () => Promise<T>) => operation();
    const engine = new DeviceSyncEngine({ api: new DeviceSyncApi(serverFetch), secrets, repository, ledger, guard, storage, externalStorage,
      backup: { openRepository: id => LocalDataRepository.open(id, factory), now: () => new Date(at) } });
    return { guard, repository, ledger, engine, dataDir };
  };
  let current = await open();
  return {
    storage, actual,
    get engine() { return current.engine; },
    get repository() { return current.repository; },
    /** Same as reloading the page after an import switched households. */
    async reload() { current.repository.close(); current = await open(); },
    async write(id: string) { await current.repository.put(receipt(id)); },
    async ids() { return (await current.repository.list('receipt-metadata')).map(r => r.id).sort(); },
    syncState() { return readSyncState(storage.getItem(LOCAL_PROFILE_KEY)!, storage); },
    close() { current.repository.close(); },
  };
}

beforeEach(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Synthetic','synthetic@example.invalid',1,1)").run();
  sqlite.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('synthetic-session','2099-01-01T00:00:00.000Z','t',?,?,'synthetic-user')")
    .run(new Date().toISOString(), new Date().toISOString());
  provider = new InMemorySyncStorageProvider();
  env = { ACCOUNT_DB: d1(sqlite) as unknown as SyncApiEnv['ACCOUNT_DB'], BETTER_AUTH_SECRET: 'x'.repeat(32) };
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

async function pair() {
  const a = await device('a');
  await a.write('receipt:a1');
  const { recoveryCode } = await a.engine.enable();
  expect(await a.engine.sync()).toMatchObject({ status: 'published' });
  const b = await device('b');
  await b.write('receipt:b-local');
  expect(await b.engine.join(recoveryCode)).toMatchObject({ status: 'imported' });
  await b.reload();
  return { a, b, recoveryCode };
}

describe('device sync engine', () => {
  it('syncs both ways, keeps the joining device\'s own data as the previous household, and stays quiet when nothing changed', async () => {
    const { a, b } = await pair();
    expect(await b.ids()).toEqual(['receipt:a1']);
    expect(b.storage.getItem(PREVIOUS_PROFILE_KEY)).not.toBeNull();
    expect(await b.engine.sync()).toEqual({ status: 'synced' });

    await b.write('receipt:b1');
    expect(await b.engine.sync()).toMatchObject({ status: 'published', sequence: 2 });
    expect(await a.engine.sync()).toMatchObject({ status: 'imported' });
    await a.reload();
    expect(await a.ids()).toEqual(['receipt:a1', 'receipt:b1']);
    expect(await a.engine.sync()).toEqual({ status: 'synced' });
    // Only ciphertext reached the provider.
    for (const key of provider.keys()) {
      const object = await provider.get(key);
      expect(new TextDecoder().decode(await new Response(object!.body).arrayBuffer())).not.toContain('Synthetic Store');
    }
    a.close(); b.close();
  });

  it('keeps both sides on a conflict and publishes the side the user chooses', async () => {
    const { a, b } = await pair();
    await a.write('receipt:a2');
    await b.write('receipt:b2');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
    // Choosing this device publishes it on top of the other version; nothing is merged.
    expect(await b.engine.keepThisDevice()).toMatchObject({ status: 'published' });
    expect(await a.engine.sync()).toMatchObject({ status: 'imported' });
    await a.reload();
    expect(await a.ids()).toEqual(['receipt:a1', 'receipt:b2']);

    await a.write('receipt:a3');
    await b.write('receipt:b3');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
    expect(await b.engine.useOtherDevice()).toMatchObject({ status: 'imported' });
    await b.reload();
    expect(await b.ids()).toEqual(['receipt:a1', 'receipt:a3', 'receipt:b2']);
    a.close(); b.close();
  });

  it('keeps the side not chosen in the cloud, exportable after later syncs replace the previous household', async () => {
    const { a, b } = await pair();
    const keptIds = async (blob: Blob) => (await readPortableBackup(blob)).localData.records.filter(r => r.kind === 'receipt-metadata').map(r => r.id).sort();
    await a.write('receipt:a2');
    await b.write('receipt:b2');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
    expect(await b.engine.keepThisDevice()).toMatchObject({ status: 'published' });
    // A's version, not chosen by B, is kept and can be exported by either device.
    const [fromA] = await b.engine.keptVersions();
    expect(fromA).toMatchObject({ fromThisDevice: false, exportable: true, state: 'published' });
    expect(await keptIds(await a.engine.exportVersion(fromA.versionId))).toEqual(['receipt:a1', 'receipt:a2']);
    await a.engine.sync(); await a.reload();

    await a.write('receipt:a3');
    await b.write('receipt:b3');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
    // Choosing the other device first sends this device's household as a conflict version.
    expect(await b.engine.useOtherDevice()).toMatchObject({ status: 'imported' });
    await b.reload();
    for (let round = 0; round < 4; round += 1) {
      await a.write(`receipt:later-${round}`);
      expect(await a.engine.sync()).toMatchObject({ status: 'published' });
      expect(await b.engine.sync()).toMatchObject({ status: 'imported' });
      await b.reload();
    }
    const kept = await b.engine.keptVersions();
    expect(kept.map(version => version.state).sort()).toEqual(['conflict', 'published']);
    const fromB = kept.find(version => version.state === 'conflict')!;
    expect(fromB.fromThisDevice).toBe(true);
    expect(await keptIds(await b.engine.exportVersion(fromB.versionId))).toEqual(['receipt:a1', 'receipt:b2', 'receipt:b3']);
    // Exporting changes nothing locally.
    expect(await b.engine.sync()).toEqual({ status: 'synced' });

    await b.engine.deleteKeptVersion(fromB.versionId);
    expect((await b.engine.keptVersions()).map(version => version.versionId)).toEqual([fromA.versionId]);
    a.close(); b.close();
  });

  it('resolves a lost publish response by its request ID without publishing twice', async () => {
    const { a, b } = await pair();
    await b.write('receipt:b1');
    dropNextPublishResponse = true;
    expect(await b.engine.sync()).toMatchObject({ status: 'offline' });
    expect(b.syncState().syncedCounter).not.toBe(b.syncState().changeCounter);
    expect(await b.engine.sync()).toMatchObject({ status: 'published', sequence: 2 });
    expect(await b.engine.sync()).toEqual({ status: 'synced' });
    const published = sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get() as { count: number };
    expect(published.count).toBe(2);
    a.close(); b.close();
  });

  it('keeps changes made during an upload as unsent', async () => {
    const { a, b } = await pair();
    await b.write('receipt:b1');
    const putChunk = DeviceSyncApi.prototype.putChunk;
    const spy = vi.spyOn(DeviceSyncApi.prototype, 'putChunk').mockImplementation(async function (this: DeviceSyncApi, ...args) {
      spy.mockRestore();
      await b.write('receipt:during-upload');
      return putChunk.apply(this, args);
    });
    expect(await b.engine.sync()).toMatchObject({ status: 'published' });
    const state = b.syncState();
    expect(state.changeCounter).toBeGreaterThan(state.syncedCounter);
    a.close(); b.close();
  });

  it('lets a wrong recovery code be retried without registering the device again', async () => {
    const a = await device('a');
    const { recoveryCode } = await a.engine.enable();
    await a.engine.sync();
    const b = await device('b');
    const wrong = recoveryCode.replace(/[0-9a-f](?=[^-]*$)/, digit => (digit === '0' ? '1' : '0'));
    await expect(b.engine.join(wrong)).rejects.toThrow();
    expect(await b.engine.join(recoveryCode)).toMatchObject({ status: 'imported' });
    const devices = sqlite.prepare('SELECT COUNT(*) AS count FROM sync_devices').get() as { count: number };
    expect(devices.count).toBe(2);
    a.close(); b.close();
  });

  it('rotates the key when a device is revoked; the revoked device must join again', async () => {
    const { a, b } = await pair();
    const bDevice = (await b.engine.devices()).find(item => item.current)!.deviceId;
    const { recoveryCode, outcome } = await a.engine.revokeDevice(bDevice);
    expect(recoveryCode).toMatch(/^KM1-/);
    expect(outcome).toMatchObject({ status: 'published' });
    expect(await b.engine.sync()).toEqual({ status: 'rejoin_required' });
    const c = await device('c');
    expect(await c.engine.join(recoveryCode)).toMatchObject({ status: 'imported' });
    a.close(); b.close(); c.close();
  });

  it('stops on this device without touching local data, and deletes cloud data on request', async () => {
    const { a, b } = await pair();
    await b.engine.stopOnThisDevice();
    expect(await b.engine.sync()).toEqual({ status: 'off' });
    expect(await b.ids()).toEqual(['receipt:a1']);
    await a.engine.deleteCloudData();
    expect(await a.engine.sync()).toEqual({ status: 'off' });
    expect(provider.keys()).toEqual([]);
    expect(await a.ids()).toEqual(['receipt:a1']);
    a.close(); b.close();
  });
});

describe('device sync with Google Drive', () => {
  it('keeps versions only in the user\'s Drive and syncs two devices through it', async () => {
    const drive = new FakeDrive();
    const a = await device('a', drive.connection());
    await a.write('receipt:a1');
    const { recoveryCode } = await a.engine.enable('google-drive');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    expect(provider.keys()).toEqual([]);
    expect(drive.files.size).toBeGreaterThan(0);
    for (const file of drive.files.values()) expect(new TextDecoder().decode(file.bytes)).not.toContain('Synthetic Store');

    const bConnection = drive.connection();
    const b = await device('b', bConnection);
    bConnection.connected = false;
    // Without a Drive connection the device stops syncing and keeps its own data.
    expect(await b.engine.join(recoveryCode)).toEqual({ status: 'storage_reconnect_required', storage: 'google-drive' });
    expect(await b.ids()).toEqual([]);
    bConnection.connected = true;
    expect(await b.engine.sync()).toMatchObject({ status: 'imported' });
    await b.reload();
    expect(await b.ids()).toEqual(['receipt:a1']);
    await b.write('receipt:b1');
    expect(await b.engine.sync()).toMatchObject({ status: 'published' });
    expect(await a.engine.sync()).toMatchObject({ status: 'imported' });
    await a.reload();
    expect(await a.ids()).toEqual(['receipt:a1', 'receipt:b1']);
    expect(provider.keys()).toEqual([]);
    a.close(); b.close();
  });

  it('leaves the Drive files of kept versions alone during cleanup and removes them when the version is deleted', async () => {
    const drive = new FakeDrive();
    const a = await device('a', drive.connection());
    await a.write('receipt:a1');
    const { recoveryCode } = await a.engine.enable('google-drive');
    await a.engine.sync();
    const b = await device('b', drive.connection());
    expect(await b.engine.join(recoveryCode)).toMatchObject({ status: 'imported' });
    await b.reload();
    await a.write('receipt:a2');
    await b.write('receipt:b2');
    await a.engine.sync();
    expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
    expect(await b.engine.keepThisDevice()).toMatchObject({ status: 'published' });
    for (let round = 0; round < 4; round += 1) {
      await b.write(`receipt:b-later-${round}`);
      expect(await b.engine.sync()).toMatchObject({ status: 'published' }); // each publish cleans up old Drive files
    }
    const [kept] = await b.engine.keptVersions();
    const exported = await a.engine.exportVersion(kept.versionId);
    expect((await readPortableBackup(exported)).localData.records.map(r => r.id)).toContain('receipt:a2');
    const before = drive.files.size;
    await a.engine.deleteKeptVersion(kept.versionId);
    expect(drive.files.size).toBe(before - kept.chunkCount);
    expect(provider.keys()).toEqual([]);
    a.close(); b.close();
  });

  it('refuses to import a version whose Drive file is missing, and changes nothing locally', async () => {
    const drive = new FakeDrive();
    const a = await device('a', drive.connection());
    await a.write('receipt:a1');
    const { recoveryCode } = await a.engine.enable('google-drive');
    await a.engine.sync();
    drive.files.delete([...drive.files.keys()][0]);
    const b = await device('b', drive.connection());
    await b.write('receipt:b-local');
    // The missing file fails verification before anything is restored.
    expect(await b.engine.join(recoveryCode)).toMatchObject({ status: 'failed' });
    expect(await b.ids()).toEqual(['receipt:b-local']);
    expect(b.storage.getItem(PREVIOUS_PROFILE_KEY)).toBeNull();
    a.close(); b.close();
  });

  it('switches from KakeiMatch Cloud to Drive only after a complete copy, and deletes the old data on request', async () => {
    const drive = new FakeDrive();
    const a = await device('a', drive.connection());
    await a.write('receipt:a1');
    await a.engine.enable();
    await a.engine.sync();
    const cloudObjects = provider.keys().length;
    expect(cloudObjects).toBeGreaterThan(0);

    drive.failPutsAfter = 0;
    expect(await a.engine.switchStorage('google-drive')).toMatchObject({ status: 'failed' });
    expect(await a.engine.storageLocation()).toBe('kakeimatch-cloud');
    await a.write('receipt:a2');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });

    drive.failPutsAfter = null;
    expect(await a.engine.switchStorage('google-drive')).toMatchObject({ status: 'published' });
    expect(await a.engine.storageLocation()).toBe('google-drive');
    expect(provider.keys().length).toBeGreaterThan(0);
    await a.engine.deleteOtherStorageData();
    expect(provider.keys()).toEqual([]);

    const b = await device('b', drive.connection());
    const stale = (await a.engine.devices()).length;
    expect(stale).toBe(1);
    await a.engine.deleteCloudData();
    expect(drive.files.size).toBe(0);
    expect(await a.ids()).toEqual(['receipt:a1', 'receipt:a2']);
    a.close(); b.close();
  });
});

describe('the same operations on each storage location', () => {
  /** Runs one sequence of syncs, a conflict and its resolution, and records what happened. */
  async function scenario(storage: 'kakeimatch-cloud' | 'google-drive') {
    sqlite.exec('DELETE FROM sync_households');
    const drive = new FakeDrive();
    const a = await device('a', drive.connection());
    const b = await device('b', drive.connection());
    const outcomes: string[] = [];
    const record = (outcome: { status: string }) => { outcomes.push(outcome.status); };
    await a.write('receipt:a1');
    const { recoveryCode } = await a.engine.enable(storage);
    record(await a.engine.sync());
    record(await b.engine.join(recoveryCode));
    await b.reload();
    await b.write('receipt:b1');
    record(await b.engine.sync());
    record(await a.engine.sync());
    await a.reload();
    await a.write('receipt:a2');
    await b.write('receipt:b2');
    record(await a.engine.sync());
    record(await b.engine.sync());
    record(await b.engine.useOtherDevice());
    await b.reload();
    const result = { outcomes, a: await a.ids(), b: await b.ids(), sequence: b.syncState().baseSequence };
    a.close(); b.close();
    return result;
  }

  it('gives the same versions, conflicts and restored households on KakeiMatch Cloud and Google Drive', async () => {
    const cloud = await scenario('kakeimatch-cloud');
    const drive = await scenario('google-drive');
    expect(cloud.outcomes).toEqual(['published', 'imported', 'published', 'imported', 'published', 'conflict', 'imported']);
    expect(drive).toEqual(cloud);
  });
});
