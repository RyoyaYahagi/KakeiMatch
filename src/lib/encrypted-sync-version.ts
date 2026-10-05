import { z } from 'zod';
import { decryptHouseholdBlob, encryptHouseholdBlob, encryptionContextSchema, ENCRYPTED_CHUNK_BYTES, MAX_ENCRYPTED_PLAIN_BYTES, type EncryptionContext } from './encrypted-household-format';
import { readPortableBackup } from './local-backup-format';

// Transport chunks are independent of the authenticated encryption chunks.
const MAX_CIPHER_BYTES = MAX_ENCRYPTED_PLAIN_BYTES + 16 * 1024;
const chunkSchema = z.object({ index: z.number().int().nonnegative(), size: z.number().int().positive().max(ENCRYPTED_CHUNK_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const encryptedSyncVersionSchema = z.object({
  context: encryptionContextSchema.extend({ generation: z.number().int().safe().positive() }),
  totalBytes: z.number().int().positive().max(MAX_CIPHER_BYTES),
  chunks: z.array(chunkSchema).min(1).max(Math.ceil(MAX_CIPHER_BYTES / ENCRYPTED_CHUNK_BYTES)),
}).strict().refine(value => value.chunks.every((chunk, index) => chunk.index === index && chunk.size === Math.min(ENCRYPTED_CHUNK_BYTES, value.totalBytes - index * ENCRYPTED_CHUNK_BYTES))
  && value.chunks.length === Math.ceil(value.totalBytes / ENCRYPTED_CHUNK_BYTES));
export type EncryptedSyncVersion = z.infer<typeof encryptedSyncVersionSchema>;

export class EncryptedSyncVersionError extends Error {
  constructor() { super('同期する家計データを確認できません。'); this.name = 'EncryptedSyncVersionError'; }
}
function fail(): never { throw new EncryptedSyncVersionError(); }
async function digest(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Input must be a consistent snapshot captured by the household coordinator, not a live export. */
export async function prepareEncryptedSyncVersion(plain: Blob, key: CryptoKey, context: EncryptionContext): Promise<{ metadata: EncryptedSyncVersion; chunk: (index: number) => Blob }> {
  if (!encryptionContextSchema.extend({ generation: z.number().int().safe().positive() }).safeParse(context).success) fail();
  // Reject incomplete/unsupported portable households before any bytes can be uploaded.
  await readPortableBackup(plain);
  const ciphertext = await encryptHouseholdBlob(plain, key, context);
  const chunks: EncryptedSyncVersion['chunks'] = [];
  for (let index = 0; index * ENCRYPTED_CHUNK_BYTES < ciphertext.size; index++) {
    const part = ciphertext.slice(index * ENCRYPTED_CHUNK_BYTES, (index + 1) * ENCRYPTED_CHUNK_BYTES);
    chunks.push({ index, size: part.size, sha256: await digest(part) });
  }
  const metadata = encryptedSyncVersionSchema.parse({ context, totalBytes: ciphertext.size, chunks });
  return { metadata, chunk: index => {
    if (!Number.isInteger(index) || index < 0 || index >= chunks.length) fail();
    return ciphertext.slice(index * ENCRYPTED_CHUNK_BYTES, (index + 1) * ENCRYPTED_CHUNK_BYTES, 'application/octet-stream');
  } };
}

/** Expected context comes from the selected version, never from the downloaded ciphertext header. */
export async function decryptPortableSyncVersion(input: unknown, expected: EncryptionContext, key: CryptoKey, readChunk: (index: number) => Promise<Blob>): Promise<Blob> {
  const parsed = encryptedSyncVersionSchema.safeParse(input);
  const context = encryptionContextSchema.safeParse(expected);
  if (!parsed.success || !context.success || JSON.stringify(parsed.data.context) !== JSON.stringify(context.data)) fail();
  const parts: Blob[] = [];
  for (const chunk of parsed.data.chunks) {
    let part: Blob;
    try { part = await readChunk(chunk.index); } catch { return fail(); }
    if (!(part instanceof Blob)) fail();
    if (part.size !== chunk.size || await digest(part) !== chunk.sha256) fail();
    parts.push(part);
  }
  const plain = await decryptHouseholdBlob(new Blob(parts), key, context.data);
  // Authentication alone does not establish a valid household or safe references.
  await readPortableBackup(plain);
  return plain;
}
