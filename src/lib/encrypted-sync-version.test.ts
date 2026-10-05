import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createHouseholdEncryptionKey, encryptHouseholdBlob, recoverHouseholdEncryptionKey, ENCRYPTED_CHUNK_BYTES } from './encrypted-household-format';
import { decryptPortableSyncVersion, prepareEncryptedSyncVersion } from './encrypted-sync-version';
import { createPortableBackup, readPortableBackup } from './local-backup-format';
import { LOCAL_PROFILE_KEY, LocalDataRepository } from './local-data';
import { INCOMPLETE_RESTORE_KEY, restoreEncryptedLocalBackup } from '../../apps/pwa/src/local-backup';

const householdId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const context = { householdId, generation: 1, versionId, parentVersionId: null };
const at = '2026-10-04T00:00:00.000Z';
const portable = (size = 3) => createPortableBackup({ actualBackup: new Uint8Array(size).fill(42), localData: {
  format: 'kakeimatch-local-data', schemaVersion: 2, exportedAt: at, records: [], blobs: [],
} });
const hash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
afterEach(() => vi.unstubAllGlobals());

describe('暗号化同期版と既存の検証付き復元の接続', () => {
  it('元端末なしで保護鍵と復旧コードから全チャンクを検証し家計簿を読む', async () => {
    const generated = await createHouseholdEncryptionKey(householdId, 1);
    const plain = await portable(ENCRYPTED_CHUNK_BYTES + 100);
    const sent = await prepareEncryptedSyncVersion(plain, generated.key, context);
    expect(sent.metadata.chunks).toHaveLength(2);
    expect(JSON.stringify(sent.metadata)).not.toContain(generated.recoveryCode);
    expect(() => sent.chunk(-1)).toThrow(); expect(() => sent.chunk(0.5)).toThrow(); expect(() => sent.chunk(2)).toThrow();
    const received = structuredClone(sent.metadata);
    const newDeviceKey = await recoverHouseholdEncryptionKey(JSON.parse(JSON.stringify(generated.protectedKey)), generated.recoveryCode, { householdId, generation: 1 });
    const result = await decryptPortableSyncVersion(received, context, newDeviceKey, async index => sent.chunk(index));
    const actual = (await readPortableBackup(result)).actualBackup;
    expect(actual.byteLength).toBe(ENCRYPTED_CHUNK_BYTES + 100);
    expect(await hash(new Blob([actual.slice().buffer]))).toBe(await hash(new Blob([new Uint8Array(actual.byteLength).fill(42)])));
  });

  it('別版・親・家計簿・世代と不正な目録をchunk取得前に拒否する', async () => {
    const generated = await createHouseholdEncryptionKey(householdId, 1);
    const sent = await prepareEncryptedSyncVersion(await portable(), generated.key, context);
    const read = vi.fn(async index => sent.chunk(index));
    for (const expected of [{ ...context, householdId: versionId }, { ...context, versionId: householdId }, { ...context, generation: 2 }, { ...context, parentVersionId: versionId }]) {
      await expect(decryptPortableSyncVersion(sent.metadata, expected, generated.key, read)).rejects.toThrow();
    }
    for (const input of [{ ...sent.metadata, totalBytes: sent.metadata.totalBytes + 1 }, { ...sent.metadata, chunks: [] },
      { ...sent.metadata, chunks: [{ ...sent.metadata.chunks[0], index: 1 }] }, { ...sent.metadata, extra: 'rejected' }]) {
      await expect(decryptPortableSyncVersion(input, context, generated.key, read)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
    await expect(prepareEncryptedSyncVersion(await portable(), generated.key, { ...context, generation: 0 })).rejects.toThrow();
  });

  it('取得失敗・欠落・順番入替・hash再計算した改ざん・誤鍵を拒否する', async () => {
    const generated = await createHouseholdEncryptionKey(householdId, 1);
    const sent = await prepareEncryptedSyncVersion(await portable(ENCRYPTED_CHUNK_BYTES + 100), generated.key, context);
    await expect(decryptPortableSyncVersion(sent.metadata, context, generated.key, async () => { throw new Error('synthetic offline'); })).rejects.toThrow();
    await expect(decryptPortableSyncVersion(sent.metadata, context, generated.key, async () => new Blob())).rejects.toThrow();
    await expect(decryptPortableSyncVersion(sent.metadata, context, generated.key, async index => sent.chunk(1 - index))).rejects.toThrow();
    const bytes = new Uint8Array(await sent.chunk(1).arrayBuffer()); bytes[bytes.length - 1] ^= 1;
    const changed = new Blob([bytes]); const metadata = structuredClone(sent.metadata); metadata.chunks[1].sha256 = await hash(changed);
    await expect(decryptPortableSyncVersion(metadata, context, generated.key, async index => index === 1 ? changed : sent.chunk(index))).rejects.toThrow();
    const wrong = await createHouseholdEncryptionKey(householdId, 1);
    await expect(decryptPortableSyncVersion(sent.metadata, context, wrong.key, async index => sent.chunk(index))).rejects.toThrow();
  });

  it('暗号認証に成功しても不正な.kmbを復元へ渡さない', async () => {
    const generated = await createHouseholdEncryptionKey(householdId, 1);
    const encrypted = await encryptHouseholdBlob(new Blob(['synthetic invalid household']), generated.key, context);
    const metadata = { context, totalBytes: encrypted.size, chunks: [{ index: 0, size: encrypted.size, sha256: await hash(encrypted) }] };
    await expect(decryptPortableSyncVersion(metadata, context, generated.key, async () => encrypted)).rejects.toThrow();
    await expect(prepareEncryptedSyncVersion(new Blob(['invalid']), generated.key, context)).rejects.toThrow();
  });

  it('全検証後のみ別保存先へ復元し、失敗時はActualとprofileを変更しない', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const factory = new IDBFactory(); const sourceId = householdId; const targetId = versionId;
    const values = new Map([[LOCAL_PROFILE_KEY, sourceId]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    vi.stubGlobal('localStorage', storage);
    const source = await LocalDataRepository.open(sourceId, factory);
    await source.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: 'synthetic-original' }, updatedAt: at });
    const ledger = { exportBackup: vi.fn(async () => new Uint8Array()), restoreBackup: vi.fn(async () => {
      expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId); return 'synthetic-restored';
    }), discardDataDirectory: vi.fn(async () => {}) };
    const generated = await createHouseholdEncryptionKey(householdId, 1);
    const sent = await prepareEncryptedSyncVersion(await portable(), generated.key, context);
    const deps = { storage, openRepository: (id: string) => LocalDataRepository.open(id, factory), makeId: () => targetId, now: () => new Date(at) };
    try {
      await expect(restoreEncryptedLocalBackup(sent.metadata, context, generated.key, async () => new Blob(['bad']), ledger, deps)).rejects.toThrow();
      expect(ledger.restoreBackup).not.toHaveBeenCalled(); expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(sourceId);
      storage.setItem(INCOMPLETE_RESTORE_KEY, 'synthetic-incomplete');
      await expect(restoreEncryptedLocalBackup(sent.metadata, context, generated.key, async index => sent.chunk(index), ledger, deps)).rejects.toThrow('以前の復元');
      expect(ledger.restoreBackup).not.toHaveBeenCalled(); storage.removeItem(INCOMPLETE_RESTORE_KEY);
      await restoreEncryptedLocalBackup(sent.metadata, context, generated.key, async index => sent.chunk(index), ledger, deps);
      expect(storage.getItem(LOCAL_PROFILE_KEY)).toBe(targetId);
      expect((await source.get('settings:budget'))?.value).toEqual({ budgetId: 'synthetic-original' });
      const target = await LocalDataRepository.open(targetId, factory);
      try { expect((await target.get('settings:budget'))?.value).toMatchObject({ budgetId: 'synthetic-restored' }); } finally { target.close(); }
    } finally { source.close(); }
  });
});
