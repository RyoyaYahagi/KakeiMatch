import { describe, expect, it } from 'vitest';
import { createHouseholdEncryptionKey, decryptHouseholdBlob, encryptHouseholdBlob, ENCRYPTED_CHUNK_BYTES, EncryptedHouseholdError, recoverHouseholdEncryptionKey } from './encrypted-household-format';

const context = { householdId: '00000000-0000-4000-8000-000000000001', generation: 2,
  versionId: '00000000-0000-4000-8000-000000000002', parentVersionId: null };
const setup = () => createHouseholdEncryptionKey(context.householdId, context.generation);
function split(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(12, 12 + length)));
  return { header, payload: bytes.slice(12 + length) };
}
function rewrite(bytes: Uint8Array, change: (header: Record<string, unknown>) => void): Blob {
  const { header, payload } = split(bytes); change(header);
  const text = new TextEncoder().encode(JSON.stringify(header));
  const prefix = bytes.slice(0, 12); new DataView(prefix.buffer).setUint32(8, text.length, false);
  return new Blob([prefix, text, payload]);
}

describe('端末側の家計暗号化と復旧コード', () => {
  it('元端末の鍵を使わず復旧し、非抽出鍵で復号する', async () => {
    const { key, recoveryCode, protectedKey } = await setup();
    expect(key.extractable).toBe(false);
    expect(recoveryCode).toMatch(/^KM1-(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
    const original = new Blob(['synthetic-household-only'], { type: 'application/vnd.kakeimatch.backup' });
    const ciphertext = await encryptHouseholdBlob(original, key, context);
    expect(await ciphertext.text()).not.toContain('synthetic-household-only');
    const recovered = await recoverHouseholdEncryptionKey(JSON.parse(JSON.stringify(protectedKey)), recoveryCode, context);
    expect(recovered.extractable).toBe(false);
    const result = await decryptHouseholdBlob(ciphertext, recovered, context);
    expect(await result.text()).toBe(await original.text()); expect(result.type).toBe(original.type);
    await expect(crypto.subtle.exportKey('raw', recovered)).rejects.toThrow();
  });

  it.each([0, 1, ENCRYPTED_CHUNK_BYTES, ENCRYPTED_CHUNK_BYTES + 17])('チャンク境界 %i bytesを復号する', async size => {
    const { key } = await setup(); const bytes = new Uint8Array(size); bytes.fill(137);
    const ciphertext = await encryptHouseholdBlob(new Blob([bytes]), key, context);
    const plain = await decryptHouseholdBlob(ciphertext, key, context);
    expect(plain.size).toBe(size);
    expect(await crypto.subtle.digest('SHA-256', await plain.arrayBuffer())).toEqual(await crypto.subtle.digest('SHA-256', bytes));
  });

  it('同じ版を再暗号化しても塩と導出鍵を再利用しない', async () => {
    const { key } = await setup(); const source = new Blob(['same']);
    const first = new Uint8Array(await (await encryptHouseholdBlob(source, key, context)).arrayBuffer());
    const second = new Uint8Array(await (await encryptHouseholdBlob(source, key, context)).arrayBuffer());
    expect(split(first).header.salt).not.toEqual(split(second).header.salt);
    expect(first).not.toEqual(second);
  });

  it('誤ったコード・別家計・世代変更・保護鍵改ざんを拒否する', async () => {
    const { recoveryCode, protectedKey } = await setup();
    const other = await setup();
    await expect(recoverHouseholdEncryptionKey(protectedKey, other.recoveryCode, context)).rejects.toBeInstanceOf(EncryptedHouseholdError);
    await expect(recoverHouseholdEncryptionKey(protectedKey, recoveryCode, { ...context, householdId: context.versionId })).rejects.toThrow();
    await expect(recoverHouseholdEncryptionKey(protectedKey, recoveryCode, { ...context, generation: 3 })).rejects.toThrow();
    await expect(recoverHouseholdEncryptionKey({ ...protectedKey, encryptedKey: '0'.repeat(96) }, recoveryCode, context)).rejects.toThrow();
    await expect(recoverHouseholdEncryptionKey(protectedKey, 'short', context)).rejects.toThrow();
    expect(JSON.stringify(protectedKey)).not.toContain(recoveryCode);
  });

  it.each(['householdId', 'generation', 'versionId', 'parentVersionId'] as const)('認証対象 %s が異なる保存物を拒否する', async field => {
    const { key } = await setup(); const cipher = await encryptHouseholdBlob(new Blob(['synthetic']), key, context);
    const expected = { ...context, [field]: field === 'generation' ? 3 : '00000000-0000-4000-8000-000000000003' };
    await expect(decryptHouseholdBlob(cipher, key, expected)).rejects.toBeInstanceOf(EncryptedHouseholdError);
  });

  it('目録と末尾の改ざん・チャンク欠落・並べ替え・差し替え・追記を全データ返却前に拒否する', async () => {
    const { key } = await setup(); const source = new Blob([new Uint8Array(ENCRYPTED_CHUNK_BYTES * 2)]);
    const cipher = await encryptHouseholdBlob(source, key, context);
    const original = new Uint8Array(await cipher.arrayBuffer()); const { header, payload } = split(original);
    const start = original.length - payload.length;
    for (const position of [start, original.length - 1]) {
      const changed = original.slice(); changed[position] ^= 1;
      await expect(decryptHouseholdBlob(new Blob([changed]), key, context)).rejects.toThrow();
    }
    const chunkStart = start + header.manifestBytes; const chunkLength = ENCRYPTED_CHUNK_BYTES + 16;
    const swapped = new Blob([original.slice(0, chunkStart), original.slice(chunkStart + chunkLength), original.slice(chunkStart, chunkStart + chunkLength)]);
    await expect(decryptHouseholdBlob(swapped, key, context)).rejects.toThrow();
    const other = new Uint8Array(await (await encryptHouseholdBlob(source, key, context)).arrayBuffer());
    await expect(decryptHouseholdBlob(new Blob([original.slice(0, chunkStart), other.slice(-chunkLength), original.slice(chunkStart + chunkLength)]), key, context)).rejects.toThrow();
    await expect(decryptHouseholdBlob(cipher.slice(0, cipher.size - chunkLength), key, context)).rejects.toThrow();
    await expect(decryptHouseholdBlob(new Blob([cipher, 'extra']), key, context)).rejects.toThrow();
  });

  it('ヘッダー偽造・平文kmb・不正サイズ・誤った鍵を拒否する', async () => {
    const { key } = await setup(); const cipher = await encryptHouseholdBlob(new Blob(['test']), key, context);
    const bytes = new Uint8Array(await cipher.arrayBuffer());
    for (const change of [
      (header: Record<string, unknown>) => { header.formatVersion = 2; },
      (header: Record<string, unknown>) => { header.salt = '0'.repeat(64); },
      (header: Record<string, unknown>) => { header.chunkCount = 64; },
      (header: Record<string, unknown>) => { header.manifestBytes = 4000; },
      (header: Record<string, unknown>) => { header.extra = true; },
    ]) await expect(decryptHouseholdBlob(rewrite(bytes, change), key, context)).rejects.toThrow();
    await expect(decryptHouseholdBlob(new Blob(['KMATCHB1plain']), key, context)).rejects.toThrow();
    await expect(decryptHouseholdBlob(cipher, (await setup()).key, context)).rejects.toThrow();
    const changedContext = { ...context, generation: 3 };
    await expect(decryptHouseholdBlob(rewrite(bytes, header => { header.context = changedContext; }), key, changedContext)).rejects.toThrow();
  });

  it('世代と鍵を作り直した後は旧鍵で新しい版を読めない', async () => {
    const previous = await setup(); const nextContext = { ...context, generation: 3 };
    const next = await createHouseholdEncryptionKey(context.householdId, 3);
    const cipher = await encryptHouseholdBlob(new Blob(['future']), next.key, nextContext);
    await expect(decryptHouseholdBlob(cipher, previous.key, nextContext)).rejects.toThrow();
    expect(await (await decryptHouseholdBlob(cipher, next.key, nextContext)).text()).toBe('future');
  });
});
