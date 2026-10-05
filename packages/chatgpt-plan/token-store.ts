import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { z } from 'zod';

export const sessionSchema = z.object({ clientId: z.string().startsWith('oaiapp_'), subject: z.string().min(1),
  accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  expiresAt: z.number().int().positive(), scopes: z.array(z.string()),
}).strict();
export type ChatGptSession = z.infer<typeof sessionSchema>;
const recordSchema = z.object({ hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/), session: sessionSchema.nullable(),
  registration: z.object({ clientId: z.string().startsWith('oaiapp_'), subject: z.string().min(1) }).strict().nullable(),
  model: z.string().max(128).nullable(), enabled: z.boolean(),
}).strict();
export type ChatGptRecord = z.infer<typeof recordSchema>;
export interface ChatGptTokenStore { read(): Promise<ChatGptRecord | null>; write(record: ChatGptRecord): Promise<void> }

/** A separately supplied secret protects tokens; it must never live beside the ciphertext. */
export class EncryptedFileTokenStore implements ChatGptTokenStore {
  private readonly secret: Buffer;
  readonly path: string;
  constructor(path: string, secretHex: string, repositoryRoot: string) {
    if (!/^[a-f0-9]{64}$/i.test(secretHex)) throw new Error('CHATGPT_PLAN_STORE_KEY must be 32 random bytes in hex.');
    this.path = resolve(path);
    const root = resolve(repositoryRoot);
    if (this.path === root || this.path.startsWith(root + '/')) throw new Error('Credential storage must be outside the repository.');
    this.secret = Buffer.from(secretHex, 'hex');
  }
  async read(): Promise<ChatGptRecord | null> {
    let source: Buffer;
    try { source = await readFile(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Protected credentials cannot be read.'); }
    try {
      if (source.length < 33 || source[0] !== 1 || source.length > 128 * 1024) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.secret, source.subarray(1, 13));
      decipher.setAAD(Buffer.from('kakeimatch-chatgpt-store-v1')); decipher.setAuthTag(source.subarray(13, 29));
      const plain = Buffer.concat([decipher.update(source.subarray(29)), decipher.final()]);
      try { return recordSchema.parse(JSON.parse(plain.toString('utf8'))); } finally { plain.fill(0); }
    } catch { throw new Error('Protected credentials cannot be verified.'); }
  }
  async write(record: ChatGptRecord): Promise<void> {
    const plain = Buffer.from(JSON.stringify(recordSchema.parse(record)));
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.secret, nonce);
    cipher.setAAD(Buffer.from('kakeimatch-chatgpt-store-v1'));
    let encrypted: Buffer;
    try { encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); } finally { plain.fill(0); }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.chatgpt-${randomBytes(16).toString('hex')}.tmp`);
    try { await writeFile(temporary, Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
  }
}
