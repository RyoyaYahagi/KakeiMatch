import { describe, expect, it, vi } from 'vitest';
import { createHouseholdEncryptionKey, encryptHouseholdBlob, recoverHouseholdEncryptionKey, ENCRYPTED_CHUNK_BYTES } from './encrypted-household-format';
import { decryptPortableSyncVersion, prepareEncryptedSyncVersion } from './encrypted-sync-version';
import { createPortableBackup, readPortableBackup } from './local-backup-format';

const householdId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const context = { householdId, generation: 1, versionId, parentVersionId: null };
const at = '2026-10-04T00:00:00.000Z';
const portable = (size = 3) => createPortableBackup({ actualBackup: new Uint8Array(size).fill(42), localData: {
  format: 'kakeimatch-local-data', schemaVersion: 2, exportedAt: at, records: [], blobs: [],
} });
const hash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');

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

});
