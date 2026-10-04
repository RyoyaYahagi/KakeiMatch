import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createActualBrowserLedger } from './actual-browser-ledger';
import { LocalDataRepository, LOCAL_PROFILE_KEY, StaleHouseholdProfileError } from './local-data';
import { createPortableBackup } from './local-backup-format';
import {
  applySyncSnapshot, createSyncSnapshot, exportLocalBackup, INCOMPLETE_RESTORE_KEY, PREVIOUS_PROFILE_KEY, recoverHouseholdSwitch,
} from '../../apps/pwa/src/local-backup';
import {
  findUnsettledOperations, HOUSEHOLD_SWITCH_KEY, readSwitchJournal, readSyncState, writeSwitchJournal, writeSyncState, initialSyncState,
} from '../../apps/pwa/src/household-sync-state';
import {
  guardLedger, HouseholdWriteGuard, LEDGER_CONDITIONAL_WRITE_METHODS, LEDGER_OUTSIDE_HOUSEHOLD_METHODS, LEDGER_READ_METHODS,
  LEDGER_WRITE_METHODS, type HouseholdLocks,
} from '../../apps/pwa/src/household-write-guard';

const activeId = '00000000-0000-4000-8000-0000000000a1';
const stagedId = '00000000-0000-4000-8000-0000000000b2';
const olderId = '00000000-0000-4000-8000-0000000000c3';
const householdId = '00000000-0000-4000-8000-0000000000d4';
const versionId = '00000000-0000-4000-8000-0000000000e5';
const at = '2026-10-04T00:00:00.000Z';

/** Web Locks semantics: shared holders coexist; requests are granted in FIFO order. */
function fakeLocks(): HouseholdLocks {
  type Waiter = { mode: LockMode; grant: () => void };
  const held = new Map<string, { mode: LockMode; count: number }>();
  const queues = new Map<string, Waiter[]>();
  const pump = (name: string) => {
    const queue = queues.get(name) ?? [];
    while (queue.length) {
      const current = held.get(name);
      if (current && !(current.mode === 'shared' && queue[0].mode === 'shared')) break;
      const next = queue.shift()!;
      held.set(name, { mode: next.mode, count: (current?.count ?? 0) + 1 });
      next.grant();
    }
  };
  return {
    request(name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) {
      return new Promise<unknown>((resolve, reject) => {
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push({ mode: options.mode ?? 'exclusive', grant: () => {
          Promise.resolve().then(() => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)).then(resolve, reject).finally(() => {
            const current = held.get(name)!;
            current.count -= 1;
            if (current.count === 0) held.delete(name);
            pump(name);
          });
        } });
        pump(name);
      });
    },
  } as HouseholdLocks;
}

let storage: Storage;
let factory: IDBFactory;
let locks: HouseholdLocks;
let clock: Date;
let guard: HouseholdWriteGuard;
let repository: LocalDataRepository;
const openPlain = (id: string) => LocalDataRepository.open(id, factory);
const deps = () => ({ storage, openRepository: openPlain, makeId: () => stagedId, now: () => clock });
const backupLedger = () => ({
  exportBackup: vi.fn(async () => new Uint8Array([1, 2, 3])),
  restoreBackup: vi.fn(async () => 'actual-budget'),
  discardDataDirectory: vi.fn(async (dataDir: string) => { void dataDir; }),
});
const receipt = (id: string, registration: string) => ({ id, kind: 'receipt-metadata' as const, updatedAt: at, value: {
  id, createdAt: at, updatedAt: at, image: null, extraction: null,
  aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
  confirmedValue: { merchant: 'Synthetic Store', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 1200, categoryId: 'category', accountId: 'account' },
  registration: { status: registration, actualTransactionId: registration === 'applied' ? 'synthetic-tx' : null, lastError: null },
} });

beforeEach(async () => {
  factory = new IDBFactory();
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  locks = fakeLocks();
  clock = new Date(at);
  storage.setItem(LOCAL_PROFILE_KEY, activeId);
  guard = new HouseholdWriteGuard(activeId, { storage, locks, now: () => clock });
  repository = await LocalDataRepository.open(activeId, factory, { writeGate: guard.repositoryGate });
});
afterEach(() => { repository.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('change tracking', () => {
  it('counts household writes before they run, and not device-only settings', async () => {
    await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'b' }, updatedAt: at });
    await repository.put({ id: 'settings:backup', kind: 'app-settings', value: { lastExportAt: at }, updatedAt: at });
    expect(readSyncState(activeId, storage).changeCounter).toBe(0);

    let seen = -1;
    await guard.write(async () => { seen = readSyncState(activeId, storage).changeCounter; });
    expect(seen).toBe(1);
    await expect(guard.write(async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    await repository.put(receipt('receipt:1', 'pending'));
    await repository.putBlob({ id: 'blob:1', ownerKind: 'receipt', ownerId: 'receipt:1', blob: new Blob(['x']), contentType: 'image/png', createdAt: at });
    await repository.delete('receipt:1');
    expect(readSyncState(activeId, storage)).toMatchObject({ changeCounter: 5, syncedCounter: 0, lastChangeAt: at });
  });

  it('refuses writes from a tab whose household was switched or is being switched', async () => {
    storage.setItem(LOCAL_PROFILE_KEY, stagedId);
    await expect(repository.put(receipt('receipt:1', 'pending'))).rejects.toBeInstanceOf(StaleHouseholdProfileError);
    await expect(repository.put({ id: 'settings:budget', kind: 'app-settings', value: {}, updatedAt: at })).rejects.toBeInstanceOf(StaleHouseholdProfileError);
    storage.setItem(LOCAL_PROFILE_KEY, activeId);
    writeSwitchJournal({ fromProfileId: activeId, toProfileId: stagedId, toDataDir: `/kakeimatch-restore/${stagedId}`, next: { householdId, baseVersionId: versionId, baseSequence: 1 }, startedAt: at }, storage);
    await expect(repository.put(receipt('receipt:1', 'pending'))).rejects.toBeInstanceOf(StaleHouseholdProfileError);
    storage.removeItem(HOUSEHOLD_SWITCH_KEY);
    expect(await repository.get('receipt:1')).toBeNull();
    expect(readSyncState(activeId, storage).changeCounter).toBe(0);
  });

  it('counts a conditional write only when it changed something, and keeps a marker if it failed', async () => {
    let fingerprint = 'a';
    await guard.writeIfChanged(async () => undefined, async () => fingerprint);
    expect(readSyncState(activeId, storage)).toMatchObject({ changeCounter: 0, pendingWriteSince: null });
    await guard.writeIfChanged(async () => { fingerprint = 'b'; }, async () => fingerprint);
    expect(readSyncState(activeId, storage)).toMatchObject({ changeCounter: 1, pendingWriteSince: null });
    await expect(guard.writeIfChanged(async () => { throw new Error('interrupted'); }, async () => fingerprint)).rejects.toThrow();
    expect(readSyncState(activeId, storage)).toMatchObject({ changeCounter: 1, pendingWriteSince: at });
  });

  it('classifies every public ledger method and wraps only household writes', async () => {
    const ledger = createActualBrowserLedger({ api: {} as never, getBudgetId: () => null, saveBudgetId: async () => undefined });
    const classified = [...LEDGER_WRITE_METHODS, ...LEDGER_CONDITIONAL_WRITE_METHODS, ...LEDGER_READ_METHODS, ...LEDGER_OUTSIDE_HOUSEHOLD_METHODS];
    expect(new Set(classified).size).toBe(classified.length);
    expect(Object.keys(ledger).sort()).toEqual([...classified].sort());

    const write = vi.spyOn(guard, 'write');
    const stub = { addAccount: vi.fn(async () => 'account'), listAccounts: vi.fn(async () => []), runDueSchedules: vi.fn(async () => undefined), listRecurringSchedules: vi.fn(async () => []) };
    const guarded = guardLedger(stub, guard);
    await guarded.listAccounts();
    expect(write).not.toHaveBeenCalled();
    await guarded.addAccount();
    expect(write).toHaveBeenCalledTimes(1);
    await guarded.runDueSchedules();
    expect(readSyncState(activeId, storage).changeCounter).toBe(1);
  });

  it('lets nested writes in one tab finish while an exclusive request from another tab waits', async () => {
    const other = new HouseholdWriteGuard(activeId, { storage, locks, now: () => clock });
    const order: string[] = [];
    let exclusiveRequested!: () => void;
    const requested = new Promise<void>(resolve => { exclusiveRequested = resolve; });
    const outer = guard.write(async () => {
      order.push('outer');
      const exclusive = other.exclusive(async () => { order.push('exclusive'); });
      exclusiveRequested();
      await requested;
      // A nested write (e.g. account metadata during an Actual write) must not queue behind it.
      await guard.write(async () => { order.push('inner'); });
      return { exclusive };
    });
    await (await outer).exclusive;
    expect(order).toEqual(['outer', 'inner', 'exclusive']);
  });
});

describe('sync snapshots', () => {
  it('defers while recent or unsettled, then exports without recording a manual backup date', async () => {
    const ledger = backupLedger();
    await repository.put(receipt('receipt:1', 'processing'));
    expect(await createSyncSnapshot(repository, ledger, guard, { storage, now: () => clock })).toMatchObject({ status: 'deferred', reason: 'recent_changes' });
    clock = new Date(Date.parse(at) + 5000);
    expect(await createSyncSnapshot(repository, ledger, guard, { storage, now: () => clock })).toMatchObject({ status: 'deferred', reason: 'unsettled_operations' });
    await repository.put(receipt('receipt:1', 'applied'));
    clock = new Date(Date.parse(at) + 10000);
    const snapshot = await createSyncSnapshot(repository, ledger, guard, { storage, now: () => clock });
    expect(snapshot).toMatchObject({ status: 'ready', profileId: activeId, changeCounter: 2 });
    expect(await repository.get('settings:backup')).toBeNull();

    await exportLocalBackup(repository, ledger, clock);
    expect((await repository.get('settings:backup'))?.value).toEqual({ lastExportAt: clock.toISOString() });
    expect(readSyncState(activeId, storage).changeCounter).toBe(2);
  });

  it('turns a marker left by an interrupted write into a change', async () => {
    writeSyncState(activeId, { ...initialSyncState, pendingWriteSince: at }, storage);
    clock = new Date(Date.parse(at) + 5000);
    const snapshot = await createSyncSnapshot(repository, backupLedger(), guard, { storage, now: () => clock });
    expect(snapshot).toMatchObject({ status: 'deferred', reason: 'recent_changes' });
    expect(readSyncState(activeId, storage)).toMatchObject({ changeCounter: 1, pendingWriteSince: null });
  });

  it('lists only operations that are still being applied', () => {
    expect(findUnsettledOperations([
      receipt('receipt:draft', 'pending'), receipt('receipt:busy', 'processing'),
      { id: 'audit:a', kind: 'correction-audit', updatedAt: at, value: { status: 'pending' } },
      { id: 'audit:b', kind: 'correction-audit', updatedAt: at, value: { status: 'restoring' } },
      { id: 'audit:c', kind: 'correction-audit', updatedAt: at, value: { status: 'applied' } },
      { id: 'resolution:a', kind: 'reconciliation-resolution', updatedAt: at, value: { status: 'processing' } },
      { id: 'resolution:b', kind: 'reconciliation-resolution', updatedAt: at, value: { status: 'failed' } },
    ])).toEqual(['receipt:busy', 'audit:a', 'audit:b', 'resolution:a']);
  });
});

describe('sync import and switch', () => {
  const next = { householdId, baseVersionId: versionId, baseSequence: 3 };
  async function version() {
    return createPortableBackup({ actualBackup: new Uint8Array([4, 5, 6]), localData: { format: 'kakeimatch-local-data', schemaVersion: 2, exportedAt: at, records: [receipt('receipt:remote', 'applied')], blobs: [] } });
  }

  it('switches to the imported household and keeps one previous household', async () => {
    const older = await openPlain(olderId);
    await older.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'old', dataDir: `/kakeimatch-restore/${olderId}` }, updatedAt: at });
    await older.put(receipt('receipt:old', 'applied'));
    older.close();
    storage.setItem(PREVIOUS_PROFILE_KEY, olderId);
    const ledger = backupLedger();

    const result = await applySyncSnapshot(await version(), ledger, guard, { profileId: activeId, changeCounter: 0, baseVersionId: null }, next, deps());
    expect(result).toEqual({ status: 'applied', profileId: stagedId });
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(stagedId);
    expect(storage.getItem(PREVIOUS_PROFILE_KEY)).toBe(activeId);
    expect(readSwitchJournal(storage)).toBeNull();
    expect(readSyncState(stagedId, storage)).toMatchObject({ ...next, changeCounter: 0, syncedCounter: 0 });
    const imported = await openPlain(stagedId);
    expect(await imported.get('receipt:remote')).not.toBeNull();
    imported.close();
    const removed = await openPlain(olderId);
    expect((await removed.serialize()).records).toEqual([]);
    removed.close();
    expect(ledger.discardDataDirectory).toHaveBeenCalledWith(`/kakeimatch-restore/${olderId}`);
  });

  it('keeps local data and discards the staged copy if this device changed meanwhile', async () => {
    const ledger = backupLedger();
    ledger.restoreBackup.mockImplementation(async () => {
      await repository.put(receipt('receipt:local', 'applied'));
      return 'actual-budget';
    });
    const result = await applySyncSnapshot(await version(), ledger, guard, { profileId: activeId, changeCounter: 0, baseVersionId: null }, next, deps());
    expect(result).toEqual({ status: 'local_changes' });
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(activeId);
    expect(await repository.get('receipt:local')).not.toBeNull();
    expect(ledger.discardDataDirectory).toHaveBeenCalledWith(`/kakeimatch-restore/${stagedId}`);
    const staged = await openPlain(stagedId);
    expect((await staged.serialize()).records).toEqual([]);
    staged.close();
  });

  it('discards a staged import when sync is stopped before the switch', async () => {
    const controller = new AbortController();
    const ledger = backupLedger();
    ledger.restoreBackup.mockImplementation(async () => {
      controller.abort();
      return 'actual-budget';
    });
    await expect(applySyncSnapshot(await version(), ledger, guard,
      { profileId: activeId, changeCounter: 0, baseVersionId: null }, next,
      { ...deps(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(activeId);
    expect(storage.getItem(PREVIOUS_PROFILE_KEY)).toBeNull();
    expect(readSwitchJournal(storage)).toBeNull();
    expect(ledger.discardDataDirectory).toHaveBeenCalledWith(`/kakeimatch-restore/${stagedId}`);
    const staged = await openPlain(stagedId);
    expect((await staged.serialize()).records).toEqual([]);
    staged.close();
  });

  it('stops importing after an incomplete Actual restore', async () => {
    storage.setItem(INCOMPLETE_RESTORE_KEY, '[]');
    const ledger = backupLedger();
    await expect(applySyncSnapshot(await version(), ledger, guard, { profileId: activeId, changeCounter: 0, baseVersionId: null }, next, deps())).rejects.toThrow('以前の復元途中');
    expect(ledger.restoreBackup).not.toHaveBeenCalled();
  });

  it('completes a switch interrupted after the pointer moved, and rolls back one interrupted before', async () => {
    const journal = { fromProfileId: activeId, toProfileId: stagedId, toDataDir: `/kakeimatch-restore/${stagedId}`, next, startedAt: at };
    const ledger = backupLedger();
    writeSwitchJournal(journal, storage);
    storage.setItem(LOCAL_PROFILE_KEY, stagedId);
    expect(await recoverHouseholdSwitch(repository, ledger, deps())).toBe('completed');
    expect(readSyncState(stagedId, storage)).toMatchObject(next);
    expect(storage.getItem(PREVIOUS_PROFILE_KEY)).toBe(activeId);
    expect(readSwitchJournal(storage)).toBeNull();

    storage.setItem(LOCAL_PROFILE_KEY, activeId);
    const staged = await openPlain(stagedId);
    await staged.put(receipt('receipt:staged', 'applied'));
    staged.close();
    writeSwitchJournal(journal, storage);
    expect(await recoverHouseholdSwitch(repository, ledger, deps())).toBe('rolled_back');
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(activeId);
    expect(ledger.discardDataDirectory).toHaveBeenCalledWith(journal.toDataDir);
    const cleared = await openPlain(stagedId);
    expect((await cleared.serialize()).records).toEqual([]);
    cleared.close();
    expect(readSwitchJournal(storage)).toBeNull();
    expect(await recoverHouseholdSwitch(repository, ledger, deps())).toBe('none');
  });
});
