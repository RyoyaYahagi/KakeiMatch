import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { ActualRestoreIncompleteError } from './actual-browser-ledger';
import { accountMetadataRecordId } from './actual-browser-ledger';
import { LocalDataRepository, LOCAL_PROFILE_KEY } from './local-data';
import { createPortableBackup, readPortableBackup } from './local-backup-format';
import { exportLocalBackup, PREVIOUS_PROFILE_KEY, restoreLocalBackup, returnToPreviousProfile, wipeLocalHousehold } from '../../apps/pwa/src/local-backup';

const sourceId = '00000000-0000-4000-8000-000000000001';
const stagingId = '00000000-0000-4000-8000-000000000002';
const at = '2026-09-30T10:00:00.000Z';
let storage: Storage;
let source: LocalDataRepository;
let factory: IDBFactory;
const ledger = () => ({ exportBackup: vi.fn(async () => new Uint8Array([1, 2, 3])), restoreBackup: vi.fn(async () => 'actual-source-id'), discardDataDirectory: vi.fn(async (dataDir: string) => { void dataDir; }) });
const openRepository = (id: string) => LocalDataRepository.open(id, factory);
const overrides = () => ({ storage, openRepository, makeId: () => stagingId, now: () => new Date(at) });
async function portable() {
  return createPortableBackup({ actualBackup: new Uint8Array([1, 2, 3]), localData: await source.serialize() });
}
beforeEach(async () => {
  factory = new IDBFactory();
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  source = await openRepository(sourceId);
  storage.setItem(LOCAL_PROFILE_KEY, sourceId);
  await source.put({ id: 'settings:backup', kind: 'app-settings', value: { lastExportAt: at }, updatedAt: at });
  await source.put({ id: 'receipt:synthetic', kind: 'receipt-metadata', value: { id: 'receipt:synthetic', createdAt: at, updatedAt: at,
    image: { blobId: 'image:synthetic', contentType: 'image/png', sizeBytes: 3 }, extraction: null,
    aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
    confirmedValue: { merchant: 'Synthetic Store', purchasedDate: '2026-09-30', purchasedTime: null, totalAmountYen: 1200, categoryId: 'category', accountId: 'account' },
    registration: { status: 'applied', actualTransactionId: 'synthetic-tx', lastError: null } }, updatedAt: at });
  await source.putBlob({ id: 'image:synthetic', ownerKind: 'receipt', ownerId: 'receipt:synthetic', blob: new Blob([new Uint8Array([1,2,3])], { type: 'image/png' }), contentType: 'image/png', createdAt: at });
});
afterEach(() => { source.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('combined staging restore', () => {
  it('publishes only after both engines restore, retains source and can return after reload', async () => {
    const saved = await source.serialize();
    const budget = ledger();
    budget.restoreBackup.mockImplementation(async () => { expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId); expect(await source.serialize()).toMatchObject({ records: saved.records, blobs: saved.blobs }); return 'actual-source-id'; });
    await restoreLocalBackup(await portable(), budget, overrides());
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(stagingId);
    expect(storage.getItem(PREVIOUS_PROFILE_KEY)).toBe(sourceId);
    expect(await source.serialize()).toMatchObject({ records: saved.records, blobs: saved.blobs });
    const reopened = await openRepository(stagingId);
    expect((await reopened.get('settings:budget'))?.value).toEqual({ budgetId: 'actual-source-id', dataDir: `/kakeimatch-restore/${stagingId}` });
    expect((await reopened.get('settings:backup'))?.value).toEqual({ lastExportAt: at });
    reopened.close();
    await returnToPreviousProfile(overrides()).catch(error => { expect(error.message).toContain('元の家計簿'); });
    // A source with an actual selection is returnable without authentication.
    await source.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'original' }, updatedAt: at });
    await returnToPreviousProfile(overrides());
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
  });

  it('preserves budget settings in .kmb and remaps them to the restored Actual budget ID', async () => {
    await source.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'actual-old' }, updatedAt: at });
    await source.put({ id: 'settings:monthly-budgets:actual-old', kind: 'app-settings', value: {
      budgetId: 'actual-old', defaults: { 'synthetic-food': 30_000 },
      monthlyOverrides: { '2026-10': { 'synthetic-food': 0 }, '2026-11': { 'synthetic-food': { inherit: true } } },
    }, updatedAt: at });
    const budget = ledger();
    const file = await exportLocalBackup(source, budget, new Date(at));
    await restoreLocalBackup(file, budget, overrides());
    const restored = await openRepository(stagingId);
    expect(await restored.get('settings:monthly-budgets:actual-old')).toBeNull();
    expect(await restored.get('settings:monthly-budgets:actual-source-id')).toMatchObject({ value: {
      budgetId: 'actual-source-id', defaults: { 'synthetic-food': 30_000 },
      monthlyOverrides: { '2026-10': { 'synthetic-food': 0 }, '2026-11': { 'synthetic-food': { inherit: true } } },
    } });
    restored.close();
  });

  it('rejects budget metadata whose record ID mismatches or mixes Actual budgets', async () => {
    const base = await source.serialize();
    const record = (budgetId: string) => ({ id: `settings:monthly-budgets:${budgetId}`, kind: 'app-settings' as const,
      value: { budgetId, defaults: {}, monthlyOverrides: {} }, updatedAt: at });
    await expect(createPortableBackup({ actualBackup: new Uint8Array([1]), localData: {
      ...base, records: [...base.records, { ...record('actual-a'), value: { ...record('actual-a').value, budgetId: 'actual-b' } }],
    } })).rejects.toThrow('対応が一致しません');
    await expect(createPortableBackup({ actualBackup: new Uint8Array([1]), localData: {
      ...base, records: [...base.records, record('actual-a'), record('actual-b')],
    } })).rejects.toThrow('複数の家計簿');
  });

  it.each(['manifest', 'checksum'])('rejects %s before any target or engine writes', async type => {
    const file = await portable(); const bytes = new Uint8Array(await file.arrayBuffer());
    if (type === 'manifest') bytes[0] ^= 1; else bytes[bytes.length - 1] ^= 1;
    const budget = ledger(); const open = vi.fn(openRepository);
    const before = (await source.serialize()).records;
    await expect(restoreLocalBackup(new Blob([bytes]), budget, { ...overrides(), openRepository: open })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled(); expect(budget.restoreBackup).not.toHaveBeenCalled();
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId); expect((await source.serialize()).records).toEqual(before);
  });

  it.each(['actual', 'records', 'blob', 'publish'])('protects active household on %s failure and discards target', async type => {
    const budget = ledger(); const before = (await source.serialize()).records;
    if (type === 'actual') budget.restoreBackup.mockRejectedValue(new Error('actual failure'));
    const open = async (id: string) => {
      const repo = await openRepository(id);
      if (type === 'records') {
        vi.spyOn(repo, 'restore').mockRejectedValueOnce(new Error(`${type} restore failure`));
      }
      return repo;
    };
    if (type === 'blob') {
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.name === 'blobs' && value.profileId === stagingId) throw new DOMException('synthetic blob failure', 'QuotaExceededError');
        return put.call(this, value, key);
      });
    }
    if (type === 'publish') {
      const write = storage.setItem.bind(storage);
      vi.spyOn(storage, 'setItem').mockImplementation((key, value) => { if (key === LOCAL_PROFILE_KEY && value === stagingId) throw new Error('quota'); write(key, value); });
    }
    await expect(restoreLocalBackup(await portable(), budget, { ...overrides(), openRepository: open })).rejects.toThrow();
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId); expect((await source.serialize()).records).toEqual(before);
    expect(budget.discardDataDirectory).toHaveBeenCalledWith(`/kakeimatch-restore/${stagingId}`);
    const target = await openRepository(stagingId); expect((await target.serialize()).records).toEqual([]); target.close();
  });

  it('surfaces failed disposal without switching active and keeps the target for wipe retry', async () => {
    const budget = ledger(); budget.restoreBackup.mockRejectedValue(new Error('invalid actual')); budget.discardDataDirectory.mockRejectedValueOnce(new Error('delete failed'));
    await expect(restoreLocalBackup(await portable(), budget, overrides())).rejects.toThrow('元の家計データは保持');
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
    await wipeLocalHousehold(source, budget, overrides());
    expect(budget.discardDataDirectory).toHaveBeenLastCalledWith(`/kakeimatch-restore/${stagingId}`);
  });

  it('full wipe clears every household profile and local selections, leaves cloud storage alone', async () => {
    const budget = ledger(); storage.setItem('synthetic-cloud-session', 'cloud-remains');
    await restoreLocalBackup(await portable(), budget, overrides());
    await wipeLocalHousehold(source, budget, overrides());
    expect((await source.serialize()).records).toEqual([]);
    const target = await openRepository(stagingId); expect((await target.serialize()).records).toEqual([]); target.close();
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBeNull(); expect(storage.getItem(PREVIOUS_PROFILE_KEY)).toBeNull();
    expect(storage.getItem('synthetic-cloud-session')).toBe('cloud-remains');
    expect(budget.discardDataDirectory.mock.calls.map(([dir]) => dir)).toEqual(['/documents', `/kakeimatch-restore/${stagingId}`]);
  });

  it('refuses a target ID collision before opening or deleting anything', async () => {
    const budget = ledger(); const open = vi.fn(openRepository);
    await expect(restoreLocalBackup(await portable(), budget, { ...overrides(), makeId: () => sourceId, openRepository: open })).rejects.toThrow('重複');
    expect(open).not.toHaveBeenCalled(); expect(budget.discardDataDirectory).not.toHaveBeenCalled();
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
  });

  it('keeps an incomplete Actual target marker and does not claim complete wipe', async () => {
    const budget = ledger(); budget.restoreBackup.mockRejectedValue(new ActualRestoreIncompleteError());
    await expect(restoreLocalBackup(await portable(), budget, overrides())).rejects.toThrow('残っている可能性');
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
    const records = (await source.serialize()).records;
    await expect(wipeLocalHousehold(source, budget, overrides())).rejects.toThrow('完全に削除');
    expect((await source.serialize()).records).toEqual(records);
    expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
  });

  it('records generation time only after successful archive creation', async () => {
    const budget = ledger(); const generated = new Date('2026-10-01T01:02:03.000Z');
    await exportLocalBackup(source, budget, generated);
    expect((await source.get('settings:backup'))?.value).toEqual({ lastExportAt: generated.toISOString() });
    budget.exportBackup.mockRejectedValue(new Error('unavailable'));
    await expect(exportLocalBackup(source, budget, new Date('2026-11-01T00:00:00Z'))).rejects.toThrow();
    expect((await source.get('settings:backup'))?.value).toEqual({ lastExportAt: generated.toISOString() });
  });

  it('exports only active-budget account types and remaps them to the restored Actual budget', async () => {
    await source.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'source-budget' }, updatedAt: at });
    await source.put({ id: accountMetadataRecordId('source-budget', 'cash-account'), kind: 'account-metadata', value: { budgetId: 'source-budget', accountId: 'cash-account', accountType: 'cash' }, updatedAt: at });
    await source.put({ id: accountMetadataRecordId('other-budget', 'cash-account'), kind: 'account-metadata', value: { budgetId: 'other-budget', accountId: 'cash-account', accountType: 'bank' }, updatedAt: at });
    const archive = await exportLocalBackup(source, ledger());
    const portableData = (await readPortableBackup(archive)).localData;
    expect(portableData.records.filter(record => record.kind === 'account-metadata').map(record => record.value)).toEqual([
      { budgetId: 'source-budget', accountId: 'cash-account', accountType: 'cash' },
    ]);

    const budget = ledger();
    await restoreLocalBackup(archive, budget, overrides());
    const restored = await openRepository(stagingId);
    expect(await restored.get(accountMetadataRecordId('actual-source-id', 'cash-account'))).toMatchObject({
      kind: 'account-metadata', value: { budgetId: 'actual-source-id', accountId: 'cash-account', accountType: 'cash' },
    });
    restored.close();
  });
});
