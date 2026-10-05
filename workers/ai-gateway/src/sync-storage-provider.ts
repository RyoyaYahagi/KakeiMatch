/**
 * Storage contract for already-encrypted, immutable sync objects (Issue #143).
 *
 * Providers only ever see ciphertext. They never decide ordering: the current
 * version pointer lives in D1, so provider timestamps are not used for sync.
 */
export interface SyncObjectContent {
  /** Exact byte length of the encrypted object. */
  size: number;
  /** Lowercase hex SHA-256 of the encrypted bytes. */
  sha256: string;
}

export interface SyncStorageProvider {
  /** Stable identifier recorded in the control plane, e.g. `kakeimatch-r2`. */
  readonly id: string;
  /**
   * Stores a new object. Never replaces an existing key: repeating the same
   * content returns `exists`; different content throws SyncStorageConflictError.
   * A body that does not match `content` throws SyncStorageIntegrityError.
   */
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, content: SyncObjectContent): Promise<"created" | "exists">;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
}

export class SyncStorageConflictError extends Error {
  constructor() { super("sync_object_conflict"); }
}
export class SyncStorageIntegrityError extends Error {
  constructor() { super("sync_object_integrity"); }
}

// Keys are built from random UUIDs only. The restricted alphabet keeps names,
// emails, and other free text out of provider object names.
const OBJECT_KEY = /^[0-9a-f-]+(?:\/[0-9a-f-]+)*$/;
export function assertSyncObjectKey(key: string): void {
  if (key.length > 200 || !OBJECT_KEY.test(key)) throw new Error("invalid_sync_object_key");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SyncStorageIntegrityError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** In-memory provider for tests. Buffers whole objects, so it is not for production. */
export class InMemorySyncStorageProvider implements SyncStorageProvider {
  readonly id = "memory";
  private readonly objects = new Map<string, { bytes: Uint8Array; sha256: string }>();

  keys(): string[] { return [...this.objects.keys()]; }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, content: SyncObjectContent): Promise<"created" | "exists"> {
    assertSyncObjectKey(key);
    const bytes = await readAll(body, content.size);
    if (bytes.byteLength !== content.size) throw new SyncStorageIntegrityError();
    const digest = hex(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
    if (digest !== content.sha256) throw new SyncStorageIntegrityError();
    const existing = this.objects.get(key);
    if (existing) {
      if (existing.sha256 !== digest || existing.bytes.byteLength !== bytes.byteLength) throw new SyncStorageConflictError();
      return "exists";
    }
    this.objects.set(key, { bytes: bytes.slice(), sha256: digest });
    return "created";
  }

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    assertSyncObjectKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes.slice();
    return {
      size: bytes.byteLength,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    };
  }

  async delete(key: string): Promise<void> {
    assertSyncObjectKey(key);
    this.objects.delete(key);
  }
}

/**
 * The subset of Cloudflare's R2 binding used here. Declared structurally so the
 * sync engine does not import the Workers runtime types or an SDK.
 */
export interface SyncR2Object {
  size: number;
  checksums: { sha256?: ArrayBuffer };
}
export interface SyncR2ObjectBody extends SyncR2Object {
  body: ReadableStream<Uint8Array>;
}
export interface SyncR2Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array,
    options: { sha256: string; onlyIf: { etagDoesNotMatch: string } },
  ): Promise<SyncR2Object | null>;
  head(key: string): Promise<SyncR2Object | null>;
  get(key: string): Promise<SyncR2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

/** KakeiMatch Cloud provider backed by a private R2 bucket. */
export class R2SyncStorageProvider implements SyncStorageProvider {
  readonly id = "kakeimatch-r2";
  constructor(private readonly bucket: SyncR2Bucket) {}

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, content: SyncObjectContent): Promise<"created" | "exists"> {
    assertSyncObjectKey(key);
    let stored: SyncR2Object | null;
    try {
      // `etagDoesNotMatch: "*"` makes the write succeed only when the key is
      // absent, and R2 rejects a body whose SHA-256 differs from `sha256`.
      stored = await this.bucket.put(key, body, { sha256: content.sha256, onlyIf: { etagDoesNotMatch: "*" } });
    } catch (error) {
      if (error instanceof Error && /sha-?256|checksum|digest/i.test(error.message)) throw new SyncStorageIntegrityError();
      throw error;
    }
    if (stored) {
      if (stored.size !== content.size) {
        await this.bucket.delete(key);
        throw new SyncStorageIntegrityError();
      }
      return "created";
    }
    // The key already exists. Same content is a safe retry; anything else is a conflict.
    const existing = await this.bucket.head(key);
    // Deleted between the two calls: report a retryable failure, not a conflict.
    if (!existing) throw new Error("sync_object_unavailable");
    if (existing.size === content.size && existing.checksums.sha256 && hex(existing.checksums.sha256) === content.sha256) return "exists";
    throw new SyncStorageConflictError();
  }

  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    assertSyncObjectKey(key);
    const object = await this.bucket.get(key);
    return object ? { body: object.body, size: object.size } : null;
  }

  async delete(key: string): Promise<void> {
    assertSyncObjectKey(key);
    await this.bucket.delete(key);
  }
}
