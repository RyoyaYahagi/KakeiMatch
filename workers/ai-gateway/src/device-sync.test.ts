import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENCRYPTED_CHUNK_BYTES, MAX_ENCRYPTED_PLAIN_BYTES } from "../../../src/lib/encrypted-household-format";
import { deleteAccountData } from "./account-auth";
import {
  DEFAULT_SYNC_LIMITS, SYNC_FORMAT_CHUNK_BYTES, SYNC_FORMAT_MAX_PLAIN_BYTES, collectSyncGarbage, sha256Hex, syncLimits,
  type SyncD1Database, type SyncLimitEnv,
} from "./device-sync";
import { handleSyncRequest } from "./device-sync-api";
import { InMemorySyncStorageProvider } from "./sync-storage-provider";

// Synthetic sessions: the user comes from a test-only header that production code never reads.
vi.mock("./account-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./account-auth")>();
  return {
    ...original,
    getAccountSession: vi.fn(async (request: Request) => {
      const user = request.headers.get("x-test-session-user");
      return user ? { user: { id: user, email: "", name: "" }, session: { id: `session-${user}`, expiresAt: new Date(0) } } : null;
    }),
  };
});

const origin = "https://sync.example.test";
const T0 = Date.parse("2026-10-03T12:00:00Z");
const migrations = ["0001_auth.sql", "0007_account_deletion.sql", "0009_device_sync.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").trim())
  .join("\n");

let miniflare: Miniflare;
let db: SyncD1Database & { exec(query: string): Promise<unknown> };
let provider: InMemorySyncStorageProvider;
let clock: { now: number };
let limitEnv: SyncLimitEnv;

beforeAll(async () => {
  miniflare = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }", modules: true, compatibilityDate: "2026-09-30",
    d1Databases: { ACCOUNT_DB: "device-sync-test" },
  });
  db = await miniflare.getD1Database("ACCOUNT_DB") as unknown as typeof db;
  await db.exec(migrations);
});
afterAll(async () => { await miniflare.dispose(); });

async function addUser(id: string, signedInAt = T0 - 60_000) {
  await db.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?, 'Synthetic', ?, 1, 1)").bind(id, `${id}@example.invalid`).run();
  // Better Auth stores session dates as ISO strings on D1.
  await db.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?, '2099-01-01T00:00:00.000Z', ?, ?, ?, ?)")
    .bind(`session-${id}`, `token-${id}`, new Date(signedInAt).toISOString(), new Date(signedInAt).toISOString(), id).run();
}

beforeEach(async () => {
  for (const table of ["user", "account_deletion_tombstones", "sync_object_deletions", "sync_deleted_households"]) await db.prepare(`DELETE FROM ${table}`).run();
  provider = new InMemorySyncStorageProvider();
  clock = { now: T0 };
  limitEnv = {};
  await addUser("alice");
  await addUser("bob");
});

// Synthetic responses are asserted field by field, so a loose JSON shape keeps the tests readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type CallOptions = { user?: string | null; credential?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null };
async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.user !== null) headers["x-test-session-user"] = options.user ?? "alice";
  if (options.origin !== null) headers.origin = options.origin ?? origin;
  if (options.credential) headers["x-sync-device-credential"] = options.credential;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const request = new Request(`${origin}/api/sync${path}`, { method, headers, body });
  const response = await handleSyncRequest(request, { ACCOUNT_DB: db, BETTER_AUTH_SECRET: "x".repeat(32), ...limitEnv }, { provider, now: () => clock.now });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as Json : {}, text };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let counter = 100;
const fresh = () => id(counter++);

async function register(user = "alice", householdId = fresh()) {
  const response = await call("POST", "/households", { user, body: { householdId } });
  expect(response.status).toBe(201);
  return { householdId, deviceId: response.json.deviceId as string, credential: response.json.credential as string };
}
async function join(user = "alice") {
  const response = await call("POST", "/devices", { user });
  expect(response.status).toBe(201);
  return { deviceId: response.json.deviceId as string, credential: response.json.credential as string, generation: response.json.generation as number };
}

async function chunkPayload(label: string, size = 24) {
  const bytes = new Uint8Array(size).map((_, index) => (label.charCodeAt(index % label.length) + index) % 251);
  return { bytes, sha256: await digestOf(bytes) };
}
async function digestOf(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function putChunk(user: string, credential: string, versionId: string, index: number, payload: { bytes: Uint8Array; sha256: string }, overrides: { sha256?: string; contentLength?: string | null } = {}) {
  const headers: Record<string, string> = { "x-chunk-sha256": overrides.sha256 ?? payload.sha256 };
  if (overrides.contentLength !== null) headers["content-length"] = overrides.contentLength ?? String(payload.bytes.byteLength);
  const request = new Request(`${origin}/api/sync/versions/${versionId}/chunks/${index}`, {
    method: "PUT", body: payload.bytes.slice().buffer as ArrayBuffer, headers: { ...headers, origin, "x-test-session-user": user, "x-sync-device-credential": credential },
  });
  const response = await handleSyncRequest(request, { ACCOUNT_DB: db, BETTER_AUTH_SECRET: "x".repeat(32), ...limitEnv }, { provider, now: () => clock.now });
  return { status: response.status, json: await response.json() as Json };
}

interface UploadOptions { user?: string; base?: string | null; versionId?: string; requestId?: string; chunks?: number; label?: string; generation?: number }
async function upload(credential: string, options: UploadOptions = {}) {
  const user = options.user ?? "alice";
  const versionId = options.versionId ?? fresh();
  const count = options.chunks ?? 2;
  const payloads = await Promise.all(Array.from({ length: count }, (_, index) => chunkPayload(`${options.label ?? versionId}-${index}`, 24 + index)));
  const current = await call("GET", "/current", { user, credential });
  const begin = await call("POST", "/uploads", {
    user, credential,
    body: {
      requestId: options.requestId ?? fresh(), versionId, baseVersionId: options.base === undefined ? current.json.current?.versionId ?? null : options.base,
      generation: options.generation ?? current.json.generation, chunkCount: count, totalBytes: payloads.reduce((sum, p) => sum + p.bytes.byteLength, 0),
    },
  });
  expect(begin.status).toBe(201);
  for (const [index, payload] of payloads.entries()) expect((await putChunk(user, credential, versionId, index, payload)).status).toBe(201);
  return { versionId, payloads };
}
async function publish(user: string, credential: string, versionId: string, requestId = fresh()) {
  return call("POST", `/versions/${versionId}/publish`, { user, credential, body: { requestId } });
}
async function row<T>(sql: string, ...values: unknown[]) { return db.prepare(sql).bind(...values).first<T>(); }

describe("configuration and request gating", () => {
  it("answers 503 not_configured when no R2 bucket or provider is bound, and 404 for unknown routes", async () => {
    const request = new Request(`${origin}/api/sync/current`, { headers: { origin, "x-test-session-user": "alice" } });
    const response = await handleSyncRequest(request, { ACCOUNT_DB: db, BETTER_AUTH_SECRET: "x".repeat(32) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect((await call("GET", "/nothing")).status).toBe(404);
    expect((await call("PATCH", "/current")).status).toBe(405);
  });

  it("requires a session and the same origin, and never allows caching", async () => {
    expect((await call("GET", "/current", { user: null })).status).toBe(401);
    expect((await call("POST", "/households", { user: null, body: { householdId: fresh() } })).status).toBe(401);
    const crossOrigin = await call("POST", "/households", { body: { householdId: fresh() }, origin: "https://evil.example.test" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.json.error).toBe("forbidden_origin");
    expect((await call("POST", "/households", { body: { householdId: fresh() }, origin: null })).status).toBe(403);
    expect((await call("GET", "/current", { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await call("DELETE", "/household", { origin: "https://evil.example.test" })).status).toBe(403);
    expect(await row("SELECT id FROM sync_households")).toBeNull();
    for (const response of [await call("GET", "/current"), await call("GET", "/current", { user: null })]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("returns only generic error codes when the control plane fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { credential } = await register();
    const failing = new Request(`${origin}/api/sync/current`, { headers: { origin, "x-test-session-user": "alice", "x-sync-device-credential": credential } });
    const brokenDb = { prepare() { throw new Error("secret-detail household=synthetic"); }, batch: db.batch.bind(db) } as unknown as SyncD1Database;
    const response = await handleSyncRequest(failing, { ACCOUNT_DB: brokenDb, BETTER_AUTH_SECRET: "x".repeat(32) }, { provider });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(warn.mock.calls).toEqual([["sync_unavailable"]]);
    warn.mockRestore();
  });
});

describe("limits", () => {
  it("falls back to defaults for invalid values and mirrors the encryption format", () => {
    expect(syncLimits({})).toEqual(DEFAULT_SYNC_LIMITS);
    expect(syncLimits({ SYNC_MAX_DEVICES: "3", SYNC_RETAINED_HISTORY: "0", SYNC_MAX_CHUNK_COUNT: "-4", SYNC_UNPUBLISHED_TTL_SECONDS: "abc" }))
      .toMatchObject({ maxDevices: 3, retainedHistory: 0, maxChunkCount: DEFAULT_SYNC_LIMITS.maxChunkCount, unpublishedTtlSeconds: DEFAULT_SYNC_LIMITS.unpublishedTtlSeconds });
    expect(SYNC_FORMAT_CHUNK_BYTES).toBe(ENCRYPTED_CHUNK_BYTES);
    expect(SYNC_FORMAT_MAX_PLAIN_BYTES).toBe(MAX_ENCRYPTED_PLAIN_BYTES);
    // The format's own decrypt limit is plaintext + 16 KiB; the sync bound must not be lower.
    expect(DEFAULT_SYNC_LIMITS.maxCiphertextBytes).toBe(MAX_ENCRYPTED_PLAIN_BYTES + 16384);
    expect(DEFAULT_SYNC_LIMITS.maxChunkBytes).toBe(ENCRYPTED_CHUNK_BYTES + 16384);
  });

  it("rejects oversize versions, chunks, and excess chunks, and enforces the declared size", async () => {
    const { credential } = await register();
    const base = { requestId: fresh(), versionId: fresh(), baseVersionId: null, generation: 1 };
    expect((await call("POST", "/uploads", { credential, body: { ...base, chunkCount: 128, totalBytes: DEFAULT_SYNC_LIMITS.maxCiphertextBytes + 1 } })).status).toBe(413);
    expect((await call("POST", "/uploads", { credential, body: { ...base, chunkCount: 129, totalBytes: 1000 } })).status).toBe(400);
    expect((await call("POST", "/uploads", { credential, body: { ...base, chunkCount: 2, totalBytes: 1 } })).status).toBe(400);
    expect((await call("POST", "/uploads", { credential, body: { ...base, chunkCount: 1, totalBytes: DEFAULT_SYNC_LIMITS.maxChunkBytes + 1 } })).status).toBe(413);

    limitEnv = { SYNC_MAX_CHUNK_BYTES: "30" };
    const versionId = fresh();
    expect((await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 30 } })).status).toBe(201);
    const big = await chunkPayload("big", 31);
    const oversize = await putChunk("alice", credential, versionId, 0, big);
    expect(oversize.status).toBe(413);
    expect(provider.keys()).toEqual([]);
    expect((await putChunk("alice", credential, versionId, 0, await chunkPayload("ok", 30), { contentLength: null })).status).toBe(411);
    expect((await putChunk("alice", credential, versionId, 1, await chunkPayload("ok", 10))).status).toBe(400);
    limitEnv = {};

    const second = fresh();
    await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId: second, baseVersionId: null, generation: 1, chunkCount: 2, totalBytes: 30 } });
    expect((await putChunk("alice", credential, second, 0, await chunkPayload("a", 20))).status).toBe(201);
    expect((await putChunk("alice", credential, second, 1, await chunkPayload("b", 11))).json.error).toBe("chunks_exceed_declared_size");
  });

  it("limits concurrent uploads, begins per hour, and stored bytes without deleting anything", async () => {
    const { credential } = await register();
    const begin = (totalBytes = 10) => call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId: fresh(), baseVersionId: null, generation: 1, chunkCount: 1, totalBytes } });
    limitEnv = { SYNC_MAX_CONCURRENT_UPLOADS: "2" };
    expect((await begin()).status).toBe(201);
    expect((await begin()).status).toBe(201);
    expect((await begin()).json.error).toBe("too_many_uploads");

    limitEnv = { SYNC_MAX_BEGINS_PER_HOUR: "2" };
    expect((await begin()).json.error).toBe("rate_limited");
    clock.now += 61 * 60 * 1000;
    limitEnv = { SYNC_MAX_BEGINS_PER_HOUR: "2", SYNC_UNPUBLISHED_TTL_SECONDS: "999999" };
    expect((await begin()).status).toBe(201);

    limitEnv = { SYNC_MAX_HOUSEHOLD_BYTES: "30", SYNC_MAX_CONCURRENT_UPLOADS: "10" };
    expect((await begin(20)).json.error).toBe("storage_limit_exceeded");
    expect(await row<{ count: number }>("SELECT COUNT(*) AS count FROM sync_versions")).toEqual({ count: 3 });
  });

  it("rejects publishing before every declared chunk is stored", async () => {
    const { credential } = await register();
    const versionId = fresh();
    await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 2, totalBytes: 40 } });
    await putChunk("alice", credential, versionId, 0, await chunkPayload("a", 20));
    expect((await publish("alice", credential, versionId)).json.error).toBe("upload_incomplete");
  });
});

describe("households, devices, and credentials", () => {
  it("requires a recent sign-in to create a household or join a device", async () => {
    await addUser("carol", T0 - 11 * 60 * 1000);
    const stale = await call("POST", "/households", { user: "carol", body: { householdId: fresh() } });
    expect(stale.status).toBe(403);
    expect(stale.json.error).toBe("recent_sign_in_required");
    const { householdId } = await register("alice");
    expect((await call("POST", "/households", { user: "alice", body: { householdId: fresh() } })).json.error).toBe("household_unavailable");
    await db.prepare("UPDATE session SET createdAt = ? WHERE id = 'session-alice'").bind(new Date(T0 - 11 * 60 * 1000).toISOString()).run();
    expect((await call("POST", "/devices", { user: "alice" })).json.error).toBe("recent_sign_in_required");
    // Epoch milliseconds are accepted as well as Better Auth's ISO strings.
    await db.prepare("UPDATE session SET createdAt = ? WHERE id = 'session-alice'").bind(T0 - 9 * 60 * 1000).run();
    expect((await call("POST", "/devices", { user: "alice" })).status).toBe(201);
    expect((await row<{ id: string }>("SELECT id FROM sync_households"))?.id).toBe(householdId);
  });

  it("stores only a hash of the device credential and no personal data", async () => {
    const { credential, deviceId } = await register();
    const stored = await row<{ credential_hash: string }>("SELECT credential_hash FROM sync_devices WHERE id = ?", deviceId);
    expect(stored?.credential_hash).toBe(await sha256Hex(credential));
    expect(stored?.credential_hash).not.toBe(credential);
    for (const table of ["sync_households", "sync_devices", "sync_versions", "sync_chunks", "sync_requests", "sync_object_deletions"]) {
      const columns = (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((column) => column.name);
      expect(columns.filter((name) => /mail|name$|^name|label|filename/.test(name) && name !== "object_key"), table).toEqual([]);
    }
    expect(JSON.stringify(await db.prepare("SELECT * FROM sync_devices").all())).not.toContain(credential);
  });

  it("limits devices and lists them without credentials", async () => {
    limitEnv = { SYNC_MAX_DEVICES: "2" };
    const first = await register();
    const second = await join();
    expect((await call("POST", "/devices")).json.error).toBe("device_limit_exceeded");
    const listed = await call("GET", "/devices", { credential: first.credential });
    // Devices registered in the same millisecond are ordered by their random IDs, so compare without order.
    const devices = listed.json.devices.map((device: { deviceId: string; current: boolean }) => [device.deviceId, device.current]);
    expect(devices).toHaveLength(2);
    expect(devices).toEqual(expect.arrayContaining([[first.deviceId, true], [second.deviceId, false]]));
    expect(listed.text).not.toContain(first.credential);
  });

  it("refuses unknown, missing, and other users' credentials", async () => {
    const alice = await register("alice");
    await register("bob");
    expect((await call("GET", "/current", { credential: "not-a-credential" })).json.error).toBe("invalid_device_credential");
    expect((await call("GET", "/current")).json.error).toBe("invalid_device_credential");
    expect((await call("GET", "/current", { user: "bob", credential: alice.credential })).json.error).toBe("invalid_device_credential");
    expect((await call("GET", "/current", { credential: alice.credential })).status).toBe(200);
  });

  it("revokes a device, moves to a new generation, and rejects old devices and generations", async () => {
    const a = await register();
    const b = await join();
    const c = await join();
    const inFlight = await upload(a.credential, { base: null });

    const revoked = await call("POST", `/devices/${b.deviceId}/revoke`, { credential: a.credential });
    expect(revoked.json).toMatchObject({ revoked: true, alreadyRevoked: false, generation: 2 });
    expect((await call("POST", `/devices/${b.deviceId}/revoke`, { credential: a.credential })).json.alreadyRevoked).toBe(true);

    expect((await call("GET", "/current", { credential: b.credential })).json.error).toBe("device_revoked");
    // The other device was not the caller, so it keeps the old generation and must rejoin with the new key.
    expect((await call("GET", "/current", { credential: c.credential })).json.error).toBe("device_generation_stale");
    const current = await call("GET", "/current", { credential: a.credential });
    expect(current.json.generation).toBe(2);

    const stale = await call("POST", "/uploads", { credential: a.credential, body: { requestId: fresh(), versionId: fresh(), baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 5 } });
    expect(stale.json.error).toBe("generation_mismatch");
    // An upload begun before the revocation can no longer be published, even by the surviving device.
    expect((await publish("alice", a.credential, inFlight.versionId)).json.error).toBe("generation_mismatch");
    expect((await putChunk("alice", a.credential, inFlight.versionId, 0, inFlight.payloads[0])).json.error).toBe("generation_mismatch");
    expect(await row("SELECT current_version_id FROM sync_households WHERE current_version_id IS NOT NULL")).toBeNull();

    const rejoined = await join();
    expect(rejoined.generation).toBe(2);
    expect((await call("GET", "/current", { credential: rejoined.credential })).status).toBe(200);
  });

  it("lets a user revoke with a recent sign-in when no device credential is available, and a revoked caller cannot act", async () => {
    const a = await register();
    const b = await join();
    expect((await call("POST", `/devices/${b.deviceId}/revoke`)).status).toBe(200);
    expect((await call("POST", `/devices/${a.deviceId}/revoke`, { credential: b.credential })).json.error).toBe("device_revoked");
    await db.prepare("UPDATE session SET createdAt = ? WHERE id = 'session-alice'").bind(new Date(T0 - 3_600_000).toISOString()).run();
    expect((await call("POST", `/devices/${a.deviceId}/revoke`)).json.error).toBe("recent_sign_in_required");
  });
});

describe("authorization boundaries between users", () => {
  it("never exposes another user's household, versions, chunks, requests, or deletion", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    const published = await upload(alice.credential, { base: null });
    const requestId = fresh();
    expect((await publish("alice", alice.credential, published.versionId, requestId)).status).toBe(200);

    expect((await call("GET", `/versions/${published.versionId}`, { user: "bob", credential: bob.credential })).status).toBe(404);
    expect((await call("GET", `/versions/${published.versionId}/chunks/0`, { user: "bob", credential: bob.credential })).status).toBe(404);
    expect((await call("GET", `/requests/${requestId}`, { user: "bob", credential: bob.credential })).status).toBe(404);
    expect((await call("GET", "/versions", { user: "bob", credential: bob.credential })).json.versions).toEqual([]);
    expect((await call("POST", `/versions/${published.versionId}/publish`, { user: "bob", credential: bob.credential, body: { requestId: fresh() } })).status).toBe(404);
    expect((await putChunk("bob", bob.credential, published.versionId, 0, published.payloads[0])).status).toBe(404);
    expect((await call("GET", "/current", { user: "bob", credential: alice.credential })).status).toBe(403);
    expect((await call("POST", `/devices/${alice.deviceId}/revoke`, { user: "bob", credential: bob.credential })).status).toBe(404);

    // Bob's deletion removes only Bob's household.
    expect((await call("DELETE", "/household", { user: "bob" })).status).toBe(200);
    expect(await row("SELECT id FROM sync_households WHERE id = ?", alice.householdId)).not.toBeNull();
    expect((await call("GET", `/versions/${published.versionId}/chunks/0`, { credential: alice.credential })).status).toBe(200);
    expect(provider.keys().length).toBe(2);
  });

  it("ignores user and household IDs supplied in the body, query, or headers", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    const versionId = fresh();
    const begin = await call("POST", "/uploads", {
      user: "bob", credential: bob.credential,
      headers: { "x-user-id": "alice", "x-household-id": alice.householdId },
      body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 5, userId: "alice", ownerUserId: "alice", householdId: alice.householdId, deviceId: alice.deviceId },
    });
    expect(begin.status).toBe(201);
    expect((await row<{ household_id: string; created_by_device_id: string }>("SELECT household_id, created_by_device_id FROM sync_versions WHERE id = ?", versionId))).toEqual({ household_id: bob.householdId, created_by_device_id: bob.deviceId });
    const created = await call("POST", "/households", { user: "carol-not-registered", body: { householdId: fresh(), userId: "alice" } });
    expect(created.status).toBe(403); // no recent session row for this synthetic user
    expect((await call("GET", `/current?userId=alice&householdId=${alice.householdId}`, { user: "bob", credential: bob.credential })).json.householdId).toBe(bob.householdId);
  });

  it("does not let a user reuse another household's ID or version ID", async () => {
    const alice = await register("alice");
    expect((await call("POST", "/households", { user: "bob", body: { householdId: alice.householdId } })).json.error).toBe("household_unavailable");
    const bob = await register("bob");
    const versionId = fresh();
    await call("POST", "/uploads", { credential: alice.credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 5 } });
    const clash = await call("POST", "/uploads", { user: "bob", credential: bob.credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 5 } });
    expect(clash.json.error).toBe("version_unavailable");
    expect(await row("SELECT id FROM sync_versions WHERE household_id = ?", bob.householdId)).toBeNull();
  });
});

describe("idempotent uploads and compare-and-swap publication", () => {
  it("makes begin idempotent per request ID and rejects reuse with different content", async () => {
    const { credential } = await register();
    const body = { requestId: fresh(), versionId: fresh(), baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 9 };
    const first = await call("POST", "/uploads", { credential, body });
    const retry = await call("POST", "/uploads", { credential, body });
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.json).toEqual(first.json);
    expect((await call("POST", "/uploads", { credential, body: { ...body, totalBytes: 10 } })).json.error).toBe("request_id_reused");
    expect(await row("SELECT COUNT(*) AS count FROM sync_versions")).toEqual({ count: 1 });
  });

  it("accepts a replayed chunk with the same content and rejects different content", async () => {
    const { credential } = await register();
    const versionId = fresh();
    await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 24 } });
    const payload = await chunkPayload("synthetic", 24);
    expect((await putChunk("alice", credential, versionId, 0, payload)).status).toBe(201);
    expect((await putChunk("alice", credential, versionId, 0, payload)).status).toBe(200);
    const other = await chunkPayload("different", 24);
    expect((await putChunk("alice", credential, versionId, 0, other)).json.error).toBe("chunk_conflict");
    expect(provider.keys().length).toBe(1);
    const stored = await row<{ sha256: string }>("SELECT sha256 FROM sync_chunks WHERE version_id = ?", versionId);
    expect(stored?.sha256).toBe(payload.sha256);
  });

  it("rejects a body that does not match its declared SHA-256 and allows the correct retry", async () => {
    const { credential } = await register();
    const versionId = fresh();
    await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 24 } });
    const payload = await chunkPayload("synthetic", 24);
    const corrupted = { bytes: payload.bytes.map((byte) => byte ^ 1), sha256: payload.sha256 };
    expect((await putChunk("alice", credential, versionId, 0, corrupted)).json.error).toBe("checksum_mismatch");
    expect(provider.keys()).toEqual([]);
    expect(await row<{ state: string }>("SELECT state FROM sync_chunks WHERE version_id = ?", versionId)).toEqual({ state: "pending" });
    expect((await publish("alice", credential, versionId)).json.error).toBe("upload_incomplete");
    expect((await putChunk("alice", credential, versionId, 0, payload)).status).toBe(201);
    expect((await publish("alice", credential, versionId)).status).toBe(200);
  });

  it("publishes in order and records sequence numbers from the server", async () => {
    const { credential } = await register();
    const first = await upload(credential, { base: null });
    expect((await publish("alice", credential, first.versionId)).json).toMatchObject({ outcome: "published", sequence: 1, currentVersionId: first.versionId });
    const second = await upload(credential);
    expect((await publish("alice", credential, second.versionId)).json).toMatchObject({ outcome: "published", sequence: 2 });
    const current = await call("GET", "/current", { credential });
    expect(current.json.current).toMatchObject({ versionId: second.versionId, parentVersionId: first.versionId, sequence: 2, state: "published" });
  });

  it("lets exactly one of two concurrent publishes from the same base win and keeps the other as a conflict", async () => {
    const a = await register();
    const b = await join();
    const base = await upload(a.credential, { base: null });
    await publish("alice", a.credential, base.versionId);
    const fromA = await upload(a.credential, { base: base.versionId, label: "device-a" });
    const fromB = await upload(b.credential, { base: base.versionId, label: "device-b" });

    const [resultA, resultB] = await Promise.all([publish("alice", a.credential, fromA.versionId), publish("alice", b.credential, fromB.versionId)]);
    expect([resultA.status, resultB.status].sort()).toEqual([200, 409]);
    const [winner, loser] = resultA.status === 200 ? [fromA, fromB] : [fromB, fromA];
    const loserResult = resultA.status === 200 ? resultB : resultA;
    expect(loserResult.json).toMatchObject({ error: "conflict", outcome: "conflict", versionId: loser.versionId, sequence: null, currentVersionId: winner.versionId });

    const household = await row<{ current_version_id: string; current_sequence: number }>("SELECT current_version_id, current_sequence FROM sync_households");
    expect(household).toEqual({ current_version_id: winner.versionId, current_sequence: 2 });
    expect(await row("SELECT state FROM sync_versions WHERE id = ?", loser.versionId)).toEqual({ state: "conflict" });
    // The losing version loses no data: every chunk is still stored and readable.
    for (const [index, payload] of loser.payloads.entries()) {
      const download = await call("GET", `/versions/${loser.versionId}/chunks/${index}`, { credential: a.credential });
      expect(download.status).toBe(200);
      expect(download.headers.get("x-chunk-sha256")).toBe(payload.sha256);
    }
    const conflicts = await call("GET", "/versions?state=conflict", { credential: b.credential });
    expect(conflicts.json.versions.map((version: { versionId: string }) => version.versionId)).toEqual([loser.versionId]);
    expect((await call("GET", `/versions/${loser.versionId}`, { credential: a.credential })).json).toMatchObject({ state: "conflict", parentVersionId: base.versionId, chunkCount: 2 });
  });

  it("detects a stale base when the second device was based on an older version", async () => {
    const a = await register();
    const b = await join();
    const first = await upload(a.credential, { base: null });
    await publish("alice", a.credential, first.versionId);
    const stale = await upload(b.credential, { base: null });
    expect((await publish("alice", b.credential, stale.versionId)).status).toBe(409);
    expect((await call("GET", "/current", { credential: a.credential })).json.current.versionId).toBe(first.versionId);
  });

  it("recovers a lost publish response by request ID without publishing twice", async () => {
    const { credential } = await register();
    const first = await upload(credential, { base: null });
    const requestId = fresh();
    expect((await publish("alice", credential, first.versionId, requestId)).status).toBe(200); // response considered lost
    const looked = await call("GET", `/requests/${requestId}`, { credential });
    expect(looked.json).toMatchObject({ kind: "publish", outcome: "published", versionId: first.versionId, sequence: 1 });

    const retry = await publish("alice", credential, first.versionId, requestId);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ replayed: true, outcome: "published", sequence: 1 });
    expect(await row("SELECT current_sequence FROM sync_households")).toEqual({ current_sequence: 1 });
    expect(await row("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'")).toEqual({ count: 1 });
    // Reusing the request ID for a different version is refused, not treated as a retry.
    const other = await upload(credential);
    expect((await publish("alice", credential, other.versionId, requestId)).json.error).toBe("request_id_reused");
  });

  it("returns the same conflict for a retried conflicting publish and refuses a second publish of the same version", async () => {
    const a = await register();
    const b = await join();
    const winner = await upload(a.credential, { base: null });
    const loser = await upload(b.credential, { base: null });
    await publish("alice", a.credential, winner.versionId);
    const requestId = fresh();
    expect((await publish("alice", b.credential, loser.versionId, requestId)).status).toBe(409);
    const retry = await publish("alice", b.credential, loser.versionId, requestId);
    expect(retry.status).toBe(409);
    expect(retry.json).toMatchObject({ outcome: "conflict", versionId: loser.versionId });
    expect((await call("GET", `/requests/${requestId}`, { credential: b.credential })).json.outcome).toBe("conflict");
    expect((await publish("alice", b.credential, loser.versionId)).json.error).toBe("version_not_uploading");
  });

  it("does not publish with a revoked device or an expired upload", async () => {
    const a = await register();
    const b = await join();
    const fromB = await upload(b.credential, { base: null });
    await call("POST", `/devices/${b.deviceId}/revoke`, { credential: a.credential });
    expect((await publish("alice", b.credential, fromB.versionId)).json.error).toBe("device_revoked");

    const fromA = await upload(a.credential, { base: null });
    clock.now += DEFAULT_SYNC_LIMITS.unpublishedTtlSeconds * 1000 + 1;
    const late = await publish("alice", a.credential, fromA.versionId);
    expect(late.status).toBe(410);
    expect((await putChunk("alice", a.credential, fromA.versionId, 0, fromA.payloads[0])).json.error).toBe("upload_expired");
    expect(await row("SELECT current_version_id FROM sync_households WHERE current_version_id IS NOT NULL")).toBeNull();
  });

  it("downloads only published or conflict versions, with the stored bytes", async () => {
    const { credential } = await register();
    const pending = await upload(credential, { base: null });
    expect((await call("GET", `/versions/${pending.versionId}`, { credential })).status).toBe(404);
    expect((await call("GET", `/versions/${pending.versionId}/chunks/0`, { credential })).status).toBe(404);
    await publish("alice", credential, pending.versionId);
    const download = await call("GET", `/versions/${pending.versionId}/chunks/1`, { credential });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("cache-control")).toBe("no-store");
    const detail = await call("GET", `/versions/${pending.versionId}`, { credential });
    expect(detail.json.chunks).toEqual(pending.payloads.map((payload, index) => ({ index, size: payload.bytes.byteLength, sha256: payload.sha256 })));
    expect((await call("GET", `/versions/${pending.versionId}/chunks/9`, { credential })).status).toBe(404);
  });
});

describe("garbage collection", () => {
  const context = () => ({ db, provider, limits: syncLimits(limitEnv), now: clock.now });

  it("removes expired unpublished uploads but keeps current, conflict, retained, and in-flight objects", async () => {
    limitEnv = { SYNC_RETAINED_HISTORY: "10" }; // publishing prunes opportunistically; keep everything until the explicit run
    const a = await register();
    const b = await join();
    const v1 = await upload(a.credential, { base: null });
    await publish("alice", a.credential, v1.versionId);
    const conflictBase = await upload(b.credential, { base: null });
    await publish("alice", b.credential, conflictBase.versionId); // conflict: base null is stale
    const v2 = await upload(a.credential);
    await publish("alice", a.credential, v2.versionId);
    const v3 = await upload(a.credential);
    await publish("alice", a.credential, v3.versionId);
    const expired = await upload(a.credential);
    clock.now += 60_000;
    const inFlight = await upload(a.credential);
    clock.now = T0 + DEFAULT_SYNC_LIMITS.unpublishedTtlSeconds * 1000 + 1;
    limitEnv = { SYNC_RETAINED_HISTORY: "1" };

    const result = await collectSyncGarbage(context());
    expect(result).toMatchObject({ expiredUploads: 1, failed: 0 });
    const states = await db.prepare("SELECT id, state FROM sync_versions ORDER BY created_at, id").all<{ id: string; state: string }>();
    const remaining = new Map(states.results.map((entry) => [entry.id, entry.state]));
    expect(remaining.has(expired.versionId)).toBe(false);
    expect(remaining.get(v3.versionId)).toBe("published"); // current
    expect(remaining.get(v2.versionId)).toBe("published"); // retained history (1)
    expect(remaining.has(v1.versionId)).toBe(false); // beyond retained history
    expect(remaining.get(conflictBase.versionId)).toBe("conflict");
    expect(remaining.get(inFlight.versionId)).toBe("uploading"); // not yet expired
    expect(result.prunedVersions).toBe(1);

    const keptKeys = (await db.prepare("SELECT object_key FROM sync_chunks").all<{ object_key: string }>()).results.map((entry) => entry.object_key).sort();
    expect(provider.keys().sort()).toEqual(keptKeys);
    expect(await row("SELECT COUNT(*) AS count FROM sync_object_deletions")).toEqual({ count: 0 });
    for (const kept of [v3, v2, conflictBase]) {
      expect((await call("GET", `/versions/${kept.versionId}/chunks/0`, { credential: a.credential })).status).toBe(200);
    }
  });

  it("prunes history beyond the retention count when a publish completes", async () => {
    const { credential } = await register();
    const versions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = await upload(credential);
      expect((await publish("alice", credential, next.versionId)).status).toBe(200);
      versions.push(next.versionId);
    }
    const kept = (await db.prepare("SELECT id FROM sync_versions ORDER BY sequence").all<{ id: string }>()).results.map((entry) => entry.id);
    expect(kept).toEqual(versions.slice(-3)); // current plus the default 2 retained
    expect(provider.keys().length).toBe(6);
  });

  it("keeps failed deletions queued and finishes them on the next run", async () => {
    const { credential } = await register();
    const abandoned = await upload(credential, { base: null });
    clock.now += DEFAULT_SYNC_LIMITS.unpublishedTtlSeconds * 1000 + 1;
    const realDelete = provider.delete.bind(provider);
    provider.delete = async () => { throw new Error("provider outage"); };
    const failed = await collectSyncGarbage(context());
    expect(failed.failed).toBeGreaterThan(0);
    expect(provider.keys().length).toBe(2);
    expect(await row("SELECT COUNT(*) AS count FROM sync_object_deletions")).toEqual({ count: 2 });
    provider.delete = realDelete;
    const recovered = await collectSyncGarbage(context());
    expect(recovered).toMatchObject({ deleted: 2, failed: 0 });
    expect(provider.keys()).toEqual([]);
    expect(await row("SELECT id FROM sync_versions WHERE id = ?", abandoned.versionId)).toBeNull();
  });

  it("deletes unreferenced objects from a chunk write that finished after its version was removed", async () => {
    const { credential } = await register();
    const versionId = fresh();
    await call("POST", "/uploads", { credential, body: { requestId: fresh(), versionId, baseVersionId: null, generation: 1, chunkCount: 1, totalBytes: 24 } });
    const payload = await chunkPayload("late", 24);
    const slowPut = provider.put.bind(provider);
    provider.put = async (key, body, content) => {
      clock.now += DEFAULT_SYNC_LIMITS.unpublishedTtlSeconds * 1000 + 1;
      await collectSyncGarbage(context()); // removes the version row while the write is in flight
      return slowPut(key, body, content); // the object lands afterwards, with no chunk row left
    };
    expect((await putChunk("alice", credential, versionId, 0, payload)).json.error).toBe("upload_aborted");
    provider.put = slowPut;
    expect(provider.keys().length).toBe(1);
    await collectSyncGarbage(context());
    expect(provider.keys()).toEqual([]);
  });

  it("expires old request results only after their retention period", async () => {
    const { credential } = await register();
    const first = await upload(credential, { base: null });
    const requestId = fresh();
    await publish("alice", credential, first.versionId, requestId);
    await collectSyncGarbage(context());
    expect((await call("GET", `/requests/${requestId}`, { credential })).status).toBe(200);
    clock.now += DEFAULT_SYNC_LIMITS.requestResultTtlSeconds * 1000 + 1;
    await collectSyncGarbage(context());
    expect((await call("GET", `/requests/${requestId}`, { credential })).status).toBe(404);
    expect(await row("SELECT current_version_id FROM sync_households")).toEqual({ current_version_id: first.versionId });
  });
});

describe("deleting cloud sync data", () => {
  it("stops new uploads, removes every object and row, and keeps old devices from recreating the household", async () => {
    const a = await register("alice", id(900));
    const b = await join();
    const published = await upload(a.credential, { base: null });
    await publish("alice", a.credential, published.versionId, id(901));
    const pending = await upload(b.credential);
    await register("bob");

    await db.prepare("UPDATE session SET createdAt = ? WHERE id = 'session-alice'").bind(new Date(T0 - 3_600_000).toISOString()).run();
    expect((await call("DELETE", "/household")).json.error).toBe("recent_sign_in_required");
    await db.prepare("UPDATE session SET createdAt = ? WHERE id = 'session-alice'").bind(new Date(T0).toISOString()).run();

    const deleted = await call("DELETE", "/household");
    expect(deleted.json).toEqual({ deleted: true, localHouseholdDataPreserved: true });
    expect(provider.keys()).toEqual([]);
    for (const table of ["sync_households", "sync_devices", "sync_versions", "sync_chunks", "sync_requests"]) {
      expect(await row(`SELECT 1 AS found FROM ${table} WHERE ${table === "sync_households" ? "id" : "household_id"} = ?`, id(900)), table).toBeNull();
    }
    expect(await row("SELECT household_id FROM sync_deleted_households WHERE household_id = ?", id(900))).not.toBeNull();
    expect(await row("SELECT id FROM sync_households WHERE owner_user_id = 'bob'")).not.toBeNull();

    // The old device cannot upload, read, or bring the household back.
    expect((await call("GET", "/current", { credential: b.credential })).json.error).toBe("household_not_found");
    expect((await putChunk("alice", b.credential, pending.versionId, 0, pending.payloads[0])).status).toBe(404);
    expect((await call("POST", "/households", { body: { householdId: id(900) } })).json.error).toBe("household_deleted");
    expect((await call("POST", "/households", { body: { householdId: fresh() } })).status).toBe(201);
  });

  it("does not report success after a partial failure, blocks uploads meanwhile, and completes on retry", async () => {
    const a = await register("alice", id(910));
    const published = await upload(a.credential, { base: null });
    await publish("alice", a.credential, published.versionId);
    const realDelete = provider.delete.bind(provider);
    let calls = 0;
    provider.delete = async (key) => { calls += 1; if (calls === 2) throw new Error("provider outage"); await realDelete(key); };

    const partial = await call("DELETE", "/household");
    expect(partial.status).toBe(503);
    expect(partial.json.error).toBe("deletion_incomplete");
    expect(await row("SELECT status FROM sync_households WHERE id = ?", id(910))).toEqual({ status: "deleting" });
    expect(provider.keys().length).toBe(1);
    // Devices are revoked and the household accepts nothing new while deletion is pending.
    expect((await call("GET", "/current", { credential: a.credential })).json.error).toBe("household_deleting");
    expect((await call("POST", "/devices")).json.error).toBe("household_deleting");
    expect(await row("SELECT household_id FROM sync_deleted_households WHERE household_id = ?", id(910))).toBeNull();

    provider.delete = realDelete;
    expect((await call("DELETE", "/household")).status).toBe(200);
    expect(provider.keys()).toEqual([]);
    expect(await row("SELECT household_id FROM sync_deleted_households WHERE household_id = ?", id(910))).not.toBeNull();
    expect((await call("DELETE", "/household")).status).toBe(404);
  });

  it("queues provider objects for removal when account deletion cascades to the household", async () => {
    const a = await register("alice", id(920));
    const published = await upload(a.credential, { base: null });
    await publish("alice", a.credential, published.versionId);
    await register("bob");
    expect(provider.keys().length).toBe(2);

    await deleteAccountData(db as never, "alice");
    expect(await row("SELECT id FROM sync_households WHERE owner_user_id = 'alice'")).toBeNull();
    expect(await row("SELECT household_id FROM sync_deleted_households WHERE household_id = ?", id(920))).not.toBeNull();
    expect(await row("SELECT COUNT(*) AS count FROM sync_object_deletions")).toEqual({ count: 2 });

    const result = await collectSyncGarbage({ db, provider, limits: syncLimits({}), now: clock.now });
    expect(result).toMatchObject({ deleted: 2, failed: 0 });
    expect(provider.keys()).toEqual([]);
    expect(await row("SELECT id FROM sync_households WHERE owner_user_id = 'bob'")).not.toBeNull();
  });
});
