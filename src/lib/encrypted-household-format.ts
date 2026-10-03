import { z } from 'zod';

export const ENCRYPTED_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ENCRYPTED_PLAIN_BYTES = 256 * 1024 * 1024;
const MAGIC = new TextEncoder().encode('KMENC001');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const id = z.uuid();
export const encryptionContextSchema = z.object({
  householdId: id, generation: z.number().int().safe().nonnegative(), versionId: id, parentVersionId: id.nullable(),
}).strict();
export type EncryptionContext = z.infer<typeof encryptionContextSchema>;
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const headerSchema = z.object({ formatVersion: z.literal(1), context: encryptionContextSchema, salt: hex32,
  chunkCount: z.number().int().min(1).max(MAX_ENCRYPTED_PLAIN_BYTES / ENCRYPTED_CHUNK_BYTES),
  manifestBytes: z.number().int().min(16).max(4096),
}).strict();
const manifestSchema = z.object({ plainBytes: z.number().int().min(0).max(MAX_ENCRYPTED_PLAIN_BYTES),
  contentType: z.string().max(128), chunkSizes: z.array(z.number().int().min(0).max(ENCRYPTED_CHUNK_BYTES)).min(1).max(64),
}).strict();
const protectedKeySchema = z.object({ formatVersion: z.literal(1), householdId: id,
  generation: z.number().int().safe().nonnegative(), salt: hex32, encryptedKey: z.string().regex(/^[0-9a-f]{96}$/),
}).strict();
export type ProtectedHouseholdKey = z.infer<typeof protectedKeySchema>;

export class EncryptedHouseholdError extends Error {
  constructor() { super('暗号化データまたは復旧コードを確認できません。'); this.name = 'EncryptedHouseholdError'; }
}
function fail(): never { throw new EncryptedHouseholdError(); }
function bytes(value: Uint8Array): ArrayBuffer { return value.slice().buffer as ArrayBuffer; }
function hex(value: Uint8Array): string { return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16)); }
function random32(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
function iv(index: number): ArrayBuffer { const value = new ArrayBuffer(12); new DataView(value).setUint32(8, index, false); return value; }
async function importMaster(value: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(value), 'HKDF', false, ['deriveKey']);
}
async function derive(master: CryptoKey, salt: string, info: unknown): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(unhex(salt)), info: encoder.encode(JSON.stringify(info)) },
    master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(header: z.infer<typeof headerSchema>, index: number): Uint8Array {
  return encoder.encode(JSON.stringify(['kakeimatch-ciphertext', header, index]));
}
async function decrypt(key: CryptoKey, index: number, additionalData: Uint8Array, data: ArrayBuffer): Promise<ArrayBuffer> {
  try { return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(index), additionalData: bytes(additionalData), tagLength: 128 }, key, data); }
  catch { return fail(); }
}

/** The returned key is non-extractable; persist only the protected key and keep the code outside this device. */
export async function createHouseholdEncryptionKey(householdId: string, generation: number): Promise<{
  key: CryptoKey; recoveryCode: string; protectedKey: ProtectedHouseholdKey;
}> {
  const identity = encryptionContextSchema.pick({ householdId: true, generation: true }).safeParse({ householdId, generation });
  if (!identity.success) fail();
  const raw = random32(); const recovery = random32();
  try {
    const recoveryCode = `KM1-${hex(recovery).match(/.{8}/g)!.join('-')}`;
    const salt = hex(random32());
    const descriptor = { formatVersion: 1 as const, ...identity.data, salt };
    const wrapping = await derive(await importMaster(recovery), salt, ['kakeimatch-recovery', descriptor]);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(0), additionalData: encoder.encode(JSON.stringify(descriptor)), tagLength: 128 }, wrapping, bytes(raw));
    return { key: await importMaster(raw), recoveryCode, protectedKey: { ...descriptor, encryptedKey: hex(new Uint8Array(ciphertext)) } };
  } finally { raw.fill(0); recovery.fill(0); }
}

export async function recoverHouseholdEncryptionKey(input: unknown, recoveryCode: string, expected: { householdId: string; generation: number }): Promise<CryptoKey> {
  const parsed = protectedKeySchema.safeParse(input);
  if (!parsed.success || parsed.data.householdId !== expected.householdId || parsed.data.generation !== expected.generation ||
    !/^KM1-(?:[0-9a-f]{8}-){7}[0-9a-f]{8}$/.test(recoveryCode)) fail();
  const { encryptedKey, ...descriptor } = parsed.data;
  const recovery = unhex(recoveryCode.slice(4).replaceAll('-', ''));
  let raw: Uint8Array | undefined;
  try {
    const wrapping = await derive(await importMaster(recovery), descriptor.salt, ['kakeimatch-recovery', descriptor]);
    raw = new Uint8Array(await decrypt(wrapping, 0, encoder.encode(JSON.stringify(descriptor)), bytes(unhex(encryptedKey))));
    if (raw.byteLength !== 32) fail();
    return await importMaster(raw);
  } finally { recovery.fill(0); raw?.fill(0); }
}

/** Each call has a fresh 256-bit salt; per-version HKDF keys use distinct counter IVs for manifest and chunks. */
export async function encryptHouseholdBlob(source: Blob, key: CryptoKey, contextInput: EncryptionContext): Promise<Blob> {
  const context = encryptionContextSchema.safeParse(contextInput);
  if (!context.success || source.size > MAX_ENCRYPTED_PLAIN_BYTES || source.type.length > 128) fail();
  const chunkCount = Math.max(1, Math.ceil(source.size / ENCRYPTED_CHUNK_BYTES));
  const manifest = encoder.encode(JSON.stringify({ plainBytes: source.size, contentType: source.type,
    chunkSizes: Array.from({ length: chunkCount }, (_, index) => Math.min(ENCRYPTED_CHUNK_BYTES, source.size - index * ENCRYPTED_CHUNK_BYTES)),
  }));
  const header = headerSchema.parse({ formatVersion: 1, context: context.data, salt: hex(random32()), chunkCount, manifestBytes: manifest.byteLength + 16 });
  const versionKey = await derive(key, header.salt, ['kakeimatch-version', header.context]);
  const serialized = encoder.encode(JSON.stringify(header));
  const prefix = new Uint8Array(12); prefix.set(MAGIC); new DataView(prefix.buffer).setUint32(8, serialized.byteLength, false);
  const parts: BlobPart[] = [prefix, serialized];
  parts.push(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(0), additionalData: bytes(aad(header, 0)), tagLength: 128 }, versionKey, bytes(manifest)));
  for (let index = 0; index < chunkCount; index++) {
    const plain = await source.slice(index * ENCRYPTED_CHUNK_BYTES, (index + 1) * ENCRYPTED_CHUNK_BYTES).arrayBuffer();
    parts.push(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(index + 1), additionalData: bytes(aad(header, index + 1)), tagLength: 128 }, versionKey, plain));
  }
  return new Blob(parts, { type: 'application/vnd.kakeimatch.encrypted' });
}

/** Returns plaintext only after every chunk authenticates. It never writes to the existing household. */
export async function decryptHouseholdBlob(source: Blob, key: CryptoKey, expectedInput: EncryptionContext): Promise<Blob> {
  const expected = encryptionContextSchema.safeParse(expectedInput);
  if (!expected.success || source.size < 12 || source.size > MAX_ENCRYPTED_PLAIN_BYTES + 16384) fail();
  const prefix = new Uint8Array(await source.slice(0, 12).arrayBuffer());
  if (!MAGIC.every((value, index) => value === prefix[index])) fail();
  const headerBytes = new DataView(prefix.buffer).getUint32(8, false);
  if (!headerBytes || headerBytes > 8192 || 12 + headerBytes > source.size) fail();
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(await source.slice(12, 12 + headerBytes).arrayBuffer())); } catch { return fail(); }
  const parsed = headerSchema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data.context) !== JSON.stringify(expected.data)) fail();
  const header = parsed.data; const versionKey = await derive(key, header.salt, ['kakeimatch-version', header.context]);
  let cursor = 12 + headerBytes;
  if (cursor + header.manifestBytes > source.size) fail();
  const manifestBytes = await decrypt(versionKey, 0, aad(header, 0), await source.slice(cursor, cursor + header.manifestBytes).arrayBuffer());
  cursor += header.manifestBytes;
  let manifestInput: unknown;
  try { manifestInput = JSON.parse(decoder.decode(manifestBytes)); } catch { return fail(); }
  const manifest = manifestSchema.safeParse(manifestInput);
  if (!manifest.success || manifest.data.chunkSizes.length !== header.chunkCount ||
    Math.max(1, Math.ceil(manifest.data.plainBytes / ENCRYPTED_CHUNK_BYTES)) !== header.chunkCount ||
    manifest.data.chunkSizes.some((size, index) => size !== Math.min(ENCRYPTED_CHUNK_BYTES, manifest.data.plainBytes - index * ENCRYPTED_CHUNK_BYTES)) ||
    cursor + manifest.data.plainBytes + header.chunkCount * 16 !== source.size) fail();
  const parts: BlobPart[] = [];
  for (let index = 0; index < header.chunkCount; index++) {
    const length = manifest.data.chunkSizes[index]! + 16;
    parts.push(await decrypt(versionKey, index + 1, aad(header, index + 1), await source.slice(cursor, cursor + length).arrayBuffer()));
    cursor += length;
  }
  return new Blob(parts, { type: manifest.data.contentType });
}
