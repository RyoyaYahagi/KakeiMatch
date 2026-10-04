import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { LocalDataRepository, LOCAL_PROFILE_KEY, type LocalDataRecord } from './local-data';
import { PREVIOUS_PROFILE_KEY } from '../../apps/pwa/src/local-backup';
import { readSyncState } from '../../apps/pwa/src/household-sync-state';
import { HouseholdWriteGuard } from '../../apps/pwa/src/household-write-guard';
import { DeviceSyncApi } from '../../apps/pwa/src/device-sync-api';
import { DeviceSyncSecretStore } from '../../apps/pwa/src/device-sync-secrets';
import { DeviceSyncEngine } from '../../apps/pwa/src/device-sync-engine';
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
const migrations = ['0001_auth.sql', '0007_account_deletion.sql', '0009_device_sync.sql', '0011_sync_household_keys.sql']
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
let failNextKeyPut = false;
let dropNextKeyPutResponse = false;
let keyPutAttempts: Array<{ credential: string | null; body: string }> = [];
let pauseNextDownload: { path: 'detail' | 'chunk'; wait: () => Promise<void> } | null = null;
let pauseNextUploadChunk: (() => Promise<void>) | null = null;

const serverFetch: typeof fetch = async (input, init = {}) => {
  const path = String(input);
  if (pauseNextDownload && init.method === 'GET'
    && (pauseNextDownload.path === 'detail' ? /\/versions\/[^/]+$/.test(path) : /\/versions\/[^/]+\/chunks\/\d+$/.test(path))) {
    const pause = pauseNextDownload;
    pauseNextDownload = null;
    await pause.wait();
  }
  if (pauseNextUploadChunk && init.method === 'PUT' && /\/versions\/[^/]+\/chunks\/\d+$/.test(path)) {
    const pause = pauseNextUploadChunk;
    pauseNextUploadChunk = null;
    await pause();
  }
  const headers = new Headers(init.headers);
  headers.set('origin', origin);
  // Browsers send Content-Length for Blob bodies; the handler requires it for chunks.
  if (init.body instanceof Blob) headers.set('content-length', String(init.body.size));
  const body = init.body instanceof Blob ? await init.body.arrayBuffer() : init.body;
  const request = new Request(`${origin}${path}`, { method: init.method, headers, body });
  if (path.endsWith('/key') && init.method === 'PUT') {
    keyPutAttempts.push({ credential: headers.get('x-sync-device-credential'), body: await request.clone().text() });
    if (failNextKeyPut) {
      failNextKeyPut = false;
      throw new TypeError('synthetic key transport failure');
    }
  }
  const response = await handleSyncRequest(request, env, { provider });
  if (dropNextKeyPutResponse && path.endsWith('/key') && init.method === 'PUT') {
    dropNextKeyPutResponse = false;
    throw new TypeError('synthetic lost key response');
  }
  if (dropNextPublishResponse && path.endsWith('/publish')) {
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

/** One device: its own IndexedDB, localStorage, Actual stand-in and engine. */
async function device(name: string) {
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
    const engine = new DeviceSyncEngine({ api: new DeviceSyncApi(serverFetch), secrets, repository, ledger, guard, storage,
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
  dropNextPublishResponse = false;
  failNextKeyPut = false;
  dropNextKeyPutResponse = false;
  keyPutAttempts = [];
  pauseNextDownload = null;
  pauseNextUploadChunk = null;
  env = { ACCOUNT_DB: d1(sqlite) as unknown as SyncApiEnv['ACCOUNT_DB'], BETTER_AUTH_SECRET: 'x'.repeat(32) };
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

async function pair() {
  const a = await device('a');
  await a.write('receipt:a1');
  const { recoveryCode } = await a.engine.enable();
  await a.engine.completeSetup();
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
    await a.engine.completeSetup();
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

describe('review regressions', () => {
  it.each(['before communication', 'after server saved the key'] as const)(
    'resumes setup after the key PUT fails %s with the same device and recovery code', async failurePoint => {
      const a = await device(`setup-${failurePoint}`);
      await a.write('receipt:setup');
      if (failurePoint === 'before communication') failNextKeyPut = true;
      else dropNextKeyPutResponse = true;

      await expect(a.engine.enable()).rejects.toThrow();
      await a.reload();
      expect(await a.engine.sync()).toEqual({ status: 'off' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_versions WHERE state = \'published\'').get()).toEqual({ count: 0 });

      const { recoveryCode } = await a.engine.enable();
      expect(recoveryCode).toMatch(/^KM1-/);
      expect(keyPutAttempts).toHaveLength(2);
      expect(keyPutAttempts[1]).toEqual(keyPutAttempts[0]);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_devices').get()).toEqual({ count: 1 });
      expect(await a.engine.sync()).toEqual({ status: 'off' });
      await a.reload();
      expect(await a.engine.enable()).toEqual({ recoveryCode });
      await a.engine.completeSetup();
      expect(await a.engine.sync()).toMatchObject({ status: 'published' });

      const b = await device(`join-${failurePoint}`);
      expect(await b.engine.join(recoveryCode)).toMatchObject({ status: 'imported' });
      await b.reload();
      expect(await b.ids()).toEqual(['receipt:setup']);
      a.close(); b.close();
    },
  );

  it.each(['detail', 'chunk'] as const)(
    'keeps a local save and reports a conflict when it arrives during remote %s download', async path => {
      const { a, b } = await pair();
      await a.write('receipt:remote-update');
      expect(await a.engine.sync()).toMatchObject({ status: 'published' });
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const profileBefore = b.storage.getItem(LOCAL_PROFILE_KEY);
      pauseNextDownload = { path, wait: async () => { entered(); await paused; } };

      const syncing = b.engine.sync();
      await ready;
      await b.write('receipt:local-during-download');
      release();
      expect(await syncing).toMatchObject({ status: 'waiting' });
      expect(b.storage.getItem(LOCAL_PROFILE_KEY)).toBe(profileBefore);
      expect(await b.ids()).toEqual(['receipt:a1', 'receipt:local-during-download']);
      expect(await b.engine.sync()).toMatchObject({ status: 'conflict' });
      expect(b.storage.getItem(LOCAL_PROFILE_KEY)).toBe(profileBefore);
      expect(await b.ids()).toEqual(['receipt:a1', 'receipt:local-during-download']);
      a.close(); b.close();
    },
  );

  it('does not import after stop while a remote download is pending', async () => {
    const { a, b } = await pair();
    await a.write('receipt:remote-update');
    expect(await a.engine.sync()).toMatchObject({ status: 'published' });
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const profileBefore = b.storage.getItem(LOCAL_PROFILE_KEY);
    pauseNextDownload = { path: 'detail', wait: async () => { entered(); await paused; } };

    const syncing = b.engine.sync();
    await ready;
    await b.engine.stopOnThisDevice();
    release();
    expect(await syncing).toEqual({ status: 'off' });
    expect(b.storage.getItem(LOCAL_PROFILE_KEY)).toBe(profileBefore);
    expect(await b.ids()).toEqual(['receipt:a1']);
    expect(await b.engine.sync()).toEqual({ status: 'off' });
    a.close(); b.close();
  });

  it('does not publish or restore sync state when stopped during chunk upload', async () => {
    const { a, b } = await pair();
    await b.write('receipt:b1');
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    pauseNextUploadChunk = async () => { entered(); await paused; };

    const syncing = b.engine.sync();
    await ready;
    await b.engine.stopOnThisDevice();
    release();
    expect(await syncing).toEqual({ status: 'off' });
    expect(await b.engine.sync()).toEqual({ status: 'off' });
    expect(b.syncState()).toMatchObject({ householdId: null, baseVersionId: null, baseSequence: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get()).toEqual({ count: 1 });
    a.close(); b.close();
  });
});
