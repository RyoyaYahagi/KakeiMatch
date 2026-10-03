import { describe, expect, it } from "vitest";
import {
  InMemorySyncStorageProvider, R2SyncStorageProvider, SyncStorageConflictError, SyncStorageIntegrityError,
  type SyncR2Bucket, type SyncR2Object, type SyncR2ObjectBody, type SyncStorageProvider,
} from "./sync-storage-provider";

const bytes = (text: string) => new TextEncoder().encode(text);
async function sha256(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const streamOf = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
const key = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/0";

/** Behaves like R2 for the calls the provider makes: put-if-absent and SHA-256 verification. */
class FakeR2Bucket implements SyncR2Bucket {
  readonly objects = new Map<string, { bytes: Uint8Array; sha256: ArrayBuffer }>();
  async put(objectKey: string, value: ReadableStream<Uint8Array> | Uint8Array, options: { sha256: string; onlyIf: { etagDoesNotMatch: string } }): Promise<SyncR2Object | null> {
    if (options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(objectKey)) return null;
    const data = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer);
    if ([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") !== options.sha256) {
      throw new Error("put: The SHA-256 checksum you specified did not match what we received. (10037)");
    }
    this.objects.set(objectKey, { bytes: data.slice(), sha256: digest });
    return { size: data.byteLength, checksums: { sha256: digest } };
  }
  async head(objectKey: string): Promise<SyncR2Object | null> {
    const object = this.objects.get(objectKey);
    return object ? { size: object.bytes.byteLength, checksums: { sha256: object.sha256 } } : null;
  }
  async get(objectKey: string): Promise<SyncR2ObjectBody | null> {
    const object = this.objects.get(objectKey);
    return object ? { size: object.bytes.byteLength, checksums: { sha256: object.sha256 }, body: streamOf(object.bytes.slice()) } : null;
  }
  async delete(objectKey: string): Promise<void> { this.objects.delete(objectKey); }
}

describe.each<[string, () => { provider: SyncStorageProvider; read: (key: string) => Promise<string | null> }]>([
  ["in-memory provider", () => {
    const provider = new InMemorySyncStorageProvider();
    return { provider, read: async (k) => { const object = await provider.get(k); return object ? readAll(object.body) : null; } };
  }],
  ["R2 provider", () => {
    const bucket = new FakeR2Bucket();
    const provider = new R2SyncStorageProvider(bucket);
    return { provider, read: async (k) => { const object = await bucket.get(k); return object ? readAll(object.body) : null; } };
  }],
])("%s contract", (_name, create) => {
  it("stores, reads, and deletes immutable objects", async () => {
    const { provider, read } = create();
    const data = bytes("synthetic ciphertext");
    expect(await provider.put(key, streamOf(data), { size: data.byteLength, sha256: await sha256(data) })).toBe("created");
    expect(await read(key)).toBe("synthetic ciphertext");
    expect((await provider.get(key))?.size).toBe(data.byteLength);
    await provider.delete(key);
    expect(await provider.get(key)).toBeNull();
    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it("treats a retry with the same content as idempotent and never overwrites different content", async () => {
    const { provider, read } = create();
    const first = bytes("first synthetic object");
    const other = bytes("other synthetic object");
    await provider.put(key, first, { size: first.byteLength, sha256: await sha256(first) });
    expect(await provider.put(key, streamOf(first), { size: first.byteLength, sha256: await sha256(first) })).toBe("exists");
    await expect(provider.put(key, other, { size: other.byteLength, sha256: await sha256(other) })).rejects.toBeInstanceOf(SyncStorageConflictError);
    expect(await read(key)).toBe("first synthetic object");
  });

  it("rejects a body that does not match the declared checksum and stores nothing", async () => {
    const { provider } = create();
    const data = bytes("synthetic ciphertext");
    await expect(provider.put(key, data, { size: data.byteLength, sha256: await sha256(bytes("something else")) })).rejects.toBeInstanceOf(SyncStorageIntegrityError);
    expect(await provider.get(key)).toBeNull();
  });

  it("rejects keys that could carry personal information", async () => {
    const { provider } = create();
    const data = bytes("x");
    for (const bad of ["person@example.test/0", "Household Name/1", "../escape", "a//b", "/leading", ""]) {
      await expect(provider.put(bad, data, { size: 1, sha256: await sha256(data) })).rejects.toThrow("invalid_sync_object_key");
    }
  });
});

describe("R2 provider specifics", () => {
  it("sends a conditional put with the checksum so R2 itself refuses to replace an object", async () => {
    const calls: Array<{ key: string; options: unknown }> = [];
    const bucket = new FakeR2Bucket();
    const original = bucket.put.bind(bucket);
    bucket.put = async (k, v, options) => { calls.push({ key: k, options }); return original(k, v, options); };
    const data = bytes("synthetic");
    await new R2SyncStorageProvider(bucket).put(key, data, { size: data.byteLength, sha256: await sha256(data) });
    expect(calls[0].options).toEqual({ sha256: await sha256(data), onlyIf: { etagDoesNotMatch: "*" } });
  });

  it("treats an object without a recorded SHA-256 as a conflict instead of trusting it", async () => {
    const bucket = new FakeR2Bucket();
    bucket.objects.set(key, { bytes: bytes("synthetic"), sha256: new ArrayBuffer(0) });
    bucket.head = async () => ({ size: 9, checksums: {} });
    const data = bytes("synthetic");
    await expect(new R2SyncStorageProvider(bucket).put(key, data, { size: 9, sha256: await sha256(data) })).rejects.toBeInstanceOf(SyncStorageConflictError);
  });

  it("reports a retryable failure when the object vanishes between the conditional put and head", async () => {
    const bucket = new FakeR2Bucket();
    bucket.put = async () => null;
    const data = bytes("synthetic");
    await expect(new R2SyncStorageProvider(bucket).put(key, data, { size: 9, sha256: await sha256(data) })).rejects.toThrow("sync_object_unavailable");
  });

  it("removes an object it just wrote when the stored size differs from the declaration", async () => {
    const bucket = new FakeR2Bucket();
    const data = bytes("synthetic");
    await expect(new R2SyncStorageProvider(bucket).put(key, data, { size: 99, sha256: await sha256(data) })).rejects.toBeInstanceOf(SyncStorageIntegrityError);
    expect(bucket.objects.has(key)).toBe(false);
  });
});
