import {
  SyncStorageConflictError,
  SyncStorageIntegrityError,
  type SyncStorageProvider,
} from "./sync-storage-provider";

/**
 * Device sync control plane (Issue #143). D1 holds ownership, device
 * credentials, version order, and upload bookkeeping. It never holds household
 * plaintext. Encrypted bytes go to a SyncStorageProvider as immutable objects.
 */

export interface SyncD1Statement {
  bind(...values: unknown[]): SyncD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}
export interface SyncD1Database {
  prepare(query: string): SyncD1Statement;
  batch<T = unknown>(statements: SyncD1Statement[]): Promise<T[]>;
}

export class SyncError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

// These mirror src/lib/encrypted-household-format.ts (a test keeps them equal):
// 256 MiB of plaintext in 4 MiB chunks, plus header, manifest, and per-chunk tags.
export const SYNC_FORMAT_CHUNK_BYTES = 4 * 1024 * 1024;
export const SYNC_FORMAT_MAX_PLAIN_BYTES = 256 * 1024 * 1024;
export const SYNC_FORMAT_OVERHEAD_BYTES = 16 * 1024;

export interface SyncLimits {
  /** Largest encrypted version: 256 MiB plaintext plus format overhead. */
  maxCiphertextBytes: number;
  /** Largest single transport chunk. */
  maxChunkBytes: number;
  maxChunkCount: number;
  /** Declared bytes of every retained, conflict, and in-flight version. */
  maxHouseholdBytes: number;
  /** Published versions kept besides the current one. */
  retainedHistory: number;
  maxBeginsPerHour: number;
  maxConcurrentUploads: number;
  unpublishedTtlSeconds: number;
  maxDevices: number;
  reauthWindowSeconds: number;
  requestResultTtlSeconds: number;
}

export const DEFAULT_SYNC_LIMITS: SyncLimits = {
  maxCiphertextBytes: SYNC_FORMAT_MAX_PLAIN_BYTES + SYNC_FORMAT_OVERHEAD_BYTES,
  maxChunkBytes: SYNC_FORMAT_CHUNK_BYTES + SYNC_FORMAT_OVERHEAD_BYTES,
  maxChunkCount: 128,
  maxHouseholdBytes: 2 * 1024 * 1024 * 1024,
  retainedHistory: 2,
  maxBeginsPerHour: 30,
  maxConcurrentUploads: 3,
  unpublishedTtlSeconds: 24 * 60 * 60,
  maxDevices: 10,
  reauthWindowSeconds: 10 * 60,
  requestResultTtlSeconds: 30 * 24 * 60 * 60,
};

export type SyncLimitEnv = Partial<Record<
  | "SYNC_MAX_CIPHERTEXT_BYTES" | "SYNC_MAX_CHUNK_BYTES" | "SYNC_MAX_CHUNK_COUNT" | "SYNC_MAX_HOUSEHOLD_BYTES"
  | "SYNC_RETAINED_HISTORY" | "SYNC_MAX_BEGINS_PER_HOUR" | "SYNC_MAX_CONCURRENT_UPLOADS"
  | "SYNC_UNPUBLISHED_TTL_SECONDS" | "SYNC_MAX_DEVICES" | "SYNC_REAUTH_WINDOW_SECONDS"
  | "SYNC_REQUEST_RESULT_TTL_SECONDS", string>>;

/** Reads limits from text bindings. Invalid or missing values fall back to the defaults. */
export function syncLimits(env: SyncLimitEnv): SyncLimits {
  const read = (value: string | undefined, fallback: number, min = 1) => {
    const parsed = value === undefined ? NaN : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
  };
  const d = DEFAULT_SYNC_LIMITS;
  return {
    maxCiphertextBytes: read(env.SYNC_MAX_CIPHERTEXT_BYTES, d.maxCiphertextBytes),
    maxChunkBytes: read(env.SYNC_MAX_CHUNK_BYTES, d.maxChunkBytes),
    maxChunkCount: read(env.SYNC_MAX_CHUNK_COUNT, d.maxChunkCount),
    maxHouseholdBytes: read(env.SYNC_MAX_HOUSEHOLD_BYTES, d.maxHouseholdBytes),
    retainedHistory: read(env.SYNC_RETAINED_HISTORY, d.retainedHistory, 0),
    maxBeginsPerHour: read(env.SYNC_MAX_BEGINS_PER_HOUR, d.maxBeginsPerHour),
    maxConcurrentUploads: read(env.SYNC_MAX_CONCURRENT_UPLOADS, d.maxConcurrentUploads),
    unpublishedTtlSeconds: read(env.SYNC_UNPUBLISHED_TTL_SECONDS, d.unpublishedTtlSeconds),
    maxDevices: read(env.SYNC_MAX_DEVICES, d.maxDevices),
    reauthWindowSeconds: read(env.SYNC_REAUTH_WINDOW_SECONDS, d.reauthWindowSeconds),
    requestResultTtlSeconds: read(env.SYNC_REQUEST_RESULT_TTL_SECONDS, d.requestResultTtlSeconds),
  };
}

export interface SyncContext {
  db: SyncD1Database;
  provider: SyncStorageProvider;
  limits: SyncLimits;
  /** Server clock in epoch milliseconds. Only the Worker's clock orders anything. */
  now: number;
}

export interface HouseholdRow {
  id: string;
  owner_user_id: string;
  provider: string;
  generation: number;
  current_version_id: string | null;
  current_sequence: number;
  status: "active" | "deleting";
}
export interface DeviceRow {
  id: string;
  household_id: string;
  generation: number;
  revoked_at: number | null;
}
export interface VersionRow {
  id: string;
  household_id: string;
  parent_version_id: string | null;
  generation: number;
  sequence: number | null;
  state: "uploading" | "published" | "conflict";
  chunk_count: number;
  total_bytes: number;
  object_prefix: string;
  created_at: number;
  published_at: number | null;
  expires_at: number;
}
interface ChunkRow { chunk_index: number; sha256: string; size_bytes: number; object_key: string; state: "pending" | "stored" }
interface RequestRow {
  kind: "begin" | "publish";
  body_hash: string;
  outcome: "created" | "published" | "conflict";
  version_id: string;
  sequence: number | null;
  created_at: number;
}

const HOUSEHOLD_COLUMNS = "id, owner_user_id, provider, generation, current_version_id, current_sequence, status";
const VERSION_COLUMNS = "id, household_id, parent_version_id, generation, sequence, state, chunk_count, total_bytes, object_prefix, created_at, published_at, expires_at";

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
// D1 counts trigger and cascade writes in `changes`, so use it only for statements without them.
const changes = (result: { meta?: { changes?: number } }) => result.meta?.changes ?? 0;

export async function findHouseholdByOwner(db: SyncD1Database, userId: string): Promise<HouseholdRow | null> {
  return db.prepare(`SELECT ${HOUSEHOLD_COLUMNS} FROM sync_households WHERE owner_user_id = ?`).bind(userId).first<HouseholdRow>();
}

/** True when the session was created by a recent sign-in (Better Auth creates one per Passkey login). */
export async function hasRecentSignIn(ctx: Pick<SyncContext, "db" | "limits" | "now">, sessionId: string, userId: string): Promise<boolean> {
  const row = await ctx.db.prepare("SELECT createdAt FROM session WHERE id = ? AND userId = ?").bind(sessionId, userId).first<{ createdAt: number | string }>();
  if (!row) return false;
  // Better Auth stores ISO strings on D1; tolerate epoch milliseconds as well.
  const createdAt = typeof row.createdAt === "number" ? row.createdAt : Date.parse(row.createdAt);
  const age = ctx.now - createdAt;
  return Number.isFinite(createdAt) && age >= -60_000 && age <= ctx.limits.reauthWindowSeconds * 1000;
}

/** Verifies the device credential against the owner's household, revocation, and generation. */
export async function authorizeDevice(db: SyncD1Database, household: HouseholdRow, credential: string | null): Promise<DeviceRow> {
  if (!credential || credential.length > 128) throw new SyncError(403, "invalid_device_credential");
  const device = await db.prepare("SELECT id, household_id, generation, revoked_at FROM sync_devices WHERE credential_hash = ? AND household_id = ?")
    .bind(await sha256Hex(credential), household.id).first<DeviceRow>();
  if (!device) throw new SyncError(403, "invalid_device_credential");
  if (device.revoked_at !== null) throw new SyncError(403, "device_revoked");
  if (device.generation !== household.generation) throw new SyncError(403, "device_generation_stale");
  return device;
}

export function assertActive(household: HouseholdRow): void {
  if (household.status !== "active") throw new SyncError(409, "household_deleting");
}

export async function createHousehold(ctx: SyncContext, userId: string, householdId: string) {
  const { db, now } = ctx;
  if (await db.prepare("SELECT household_id FROM sync_deleted_households WHERE household_id = ?").bind(householdId).first()) {
    throw new SyncError(410, "household_deleted");
  }
  const credential = newCredential();
  const deviceId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`INSERT INTO sync_households(id, owner_user_id, provider, generation, current_version_id, current_sequence, status, created_at, updated_at)
        SELECT ?, ?, ?, 1, NULL, 0, 'active', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM sync_deleted_households WHERE household_id = ?)`)
        .bind(householdId, userId, ctx.provider.id, now, now, householdId),
      db.prepare("INSERT INTO sync_devices(id, household_id, credential_hash, generation, created_at) VALUES (?, ?, ?, 1, ?)")
        .bind(deviceId, householdId, await sha256Hex(credential), now),
    ]);
  } catch (error) {
    // Do not reveal whether the ID belongs to someone else.
    if (await findHouseholdByOwner(db, userId) || await db.prepare("SELECT id FROM sync_households WHERE id = ?").bind(householdId).first()) {
      throw new SyncError(409, "household_unavailable");
    }
    if (await db.prepare("SELECT household_id FROM sync_deleted_households WHERE household_id = ?").bind(householdId).first()) {
      throw new SyncError(410, "household_deleted");
    }
    throw error;
  }
  return { householdId, generation: 1, provider: ctx.provider.id, deviceId, credential };
}

export async function joinDevice(ctx: SyncContext, household: HouseholdRow) {
  assertActive(household);
  const { db, now } = ctx;
  const active = await db.prepare("SELECT COUNT(*) AS count FROM sync_devices WHERE household_id = ? AND revoked_at IS NULL AND generation = ?")
    .bind(household.id, household.generation).first<{ count: number }>();
  if ((active?.count ?? 0) >= ctx.limits.maxDevices) throw new SyncError(409, "device_limit_exceeded");
  const credential = newCredential();
  const deviceId = crypto.randomUUID();
  // The device takes the generation current at insert time, never a client-supplied one.
  const result = await db.prepare(`INSERT INTO sync_devices(id, household_id, credential_hash, generation, created_at)
    SELECT ?, id, ?, generation, ? FROM sync_households WHERE id = ? AND status = 'active'`)
    .bind(deviceId, await sha256Hex(credential), now, household.id).run();
  if (changes(result) !== 1) throw new SyncError(409, "household_deleting");
  const device = await db.prepare("SELECT generation FROM sync_devices WHERE id = ?").bind(deviceId).first<{ generation: number }>();
  return { householdId: household.id, generation: device?.generation ?? household.generation, provider: household.provider, deviceId, credential };
}

export async function listDevices(db: SyncD1Database, household: HouseholdRow, callerDeviceId: string) {
  const rows = await db.prepare("SELECT id, generation, created_at, revoked_at FROM sync_devices WHERE household_id = ? ORDER BY created_at, id")
    .bind(household.id).all<{ id: string; generation: number; created_at: number; revoked_at: number | null }>();
  return rows.results.map((row) => ({
    deviceId: row.id, generation: row.generation, createdAt: iso(row.created_at), revokedAt: iso(row.revoked_at), current: row.id === callerDeviceId,
  }));
}

export async function getVersion(db: SyncD1Database, householdId: string, versionId: string): Promise<VersionRow | null> {
  return db.prepare(`SELECT ${VERSION_COLUMNS} FROM sync_versions WHERE id = ? AND household_id = ?`).bind(versionId, householdId).first<VersionRow>();
}

export function versionJson(row: VersionRow, chunks?: Array<{ index: number; size: number; sha256: string }>) {
  return {
    versionId: row.id, parentVersionId: row.parent_version_id, generation: row.generation, sequence: row.sequence, state: row.state,
    chunkCount: row.chunk_count, totalBytes: row.total_bytes, createdAt: iso(row.created_at), publishedAt: iso(row.published_at),
    ...(chunks ? { chunks } : {}),
  };
}

export async function getCurrent(db: SyncD1Database, household: HouseholdRow) {
  const current = household.current_version_id ? await getVersion(db, household.id, household.current_version_id) : null;
  return {
    householdId: household.id, generation: household.generation, provider: household.provider, status: household.status,
    currentSequence: household.current_sequence,
    current: current ? versionJson(current) : null,
  };
}

export async function listVersions(db: SyncD1Database, household: HouseholdRow, state: "published" | "conflict" | null) {
  const rows = await db.prepare(`SELECT ${VERSION_COLUMNS} FROM sync_versions
    WHERE household_id = ? AND state IN ('published', 'conflict') AND (? IS NULL OR state = ?)
    ORDER BY created_at DESC, id LIMIT 50`).bind(household.id, state, state).all<VersionRow>();
  return rows.results.map((row) => versionJson(row));
}

export async function versionWithChunks(db: SyncD1Database, household: HouseholdRow, versionId: string) {
  const version = await getVersion(db, household.id, versionId);
  if (!version || version.state === "uploading") throw new SyncError(404, "version_not_found");
  const chunks = await db.prepare("SELECT chunk_index, sha256, size_bytes FROM sync_chunks WHERE version_id = ? AND state = 'stored' ORDER BY chunk_index")
    .bind(versionId).all<{ chunk_index: number; sha256: string; size_bytes: number }>();
  return versionJson(version, chunks.results.map((row) => ({ index: row.chunk_index, size: row.size_bytes, sha256: row.sha256 })));
}

export async function openChunk(ctx: SyncContext, household: HouseholdRow, versionId: string, index: number) {
  const version = await getVersion(ctx.db, household.id, versionId);
  if (!version || version.state === "uploading") throw new SyncError(404, "version_not_found");
  const chunk = await ctx.db.prepare("SELECT chunk_index, sha256, size_bytes, object_key, state FROM sync_chunks WHERE version_id = ? AND chunk_index = ? AND state = 'stored'")
    .bind(versionId, index).first<ChunkRow>();
  if (!chunk) throw new SyncError(404, "chunk_not_found");
  const object = await ctx.provider.get(chunk.object_key);
  // A published version whose object is missing is data loss, not an empty household.
  if (!object) throw new SyncError(503, "storage_object_missing");
  return { body: object.body, size: object.size, sha256: chunk.sha256 };
}

async function findRequest(db: SyncD1Database, householdId: string, requestId: string): Promise<RequestRow | null> {
  return db.prepare("SELECT kind, body_hash, outcome, version_id, sequence, created_at FROM sync_requests WHERE household_id = ? AND request_id = ?")
    .bind(householdId, requestId).first<RequestRow>();
}

export async function lookupRequest(db: SyncD1Database, household: HouseholdRow, requestId: string) {
  const row = await findRequest(db, household.id, requestId);
  if (!row) throw new SyncError(404, "request_not_found");
  return { requestId, kind: row.kind, outcome: row.outcome, versionId: row.version_id, sequence: row.sequence, recordedAt: iso(row.created_at) };
}

export interface BeginInput {
  requestId: string;
  versionId: string;
  baseVersionId: string | null;
  generation: number;
  chunkCount: number;
  totalBytes: number;
}

async function checkUploadLimits(ctx: SyncContext, household: HouseholdRow, totalBytes: number): Promise<void> {
  const { db, now, limits } = ctx;
  const uploading = await db.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE household_id = ? AND state = 'uploading' AND expires_at > ?")
    .bind(household.id, now).first<{ count: number }>();
  if ((uploading?.count ?? 0) >= limits.maxConcurrentUploads) throw new SyncError(429, "too_many_uploads");
  const begins = await db.prepare("SELECT COUNT(*) AS count FROM sync_requests WHERE household_id = ? AND kind = 'begin' AND created_at > ?")
    .bind(household.id, now - 60 * 60 * 1000).first<{ count: number }>();
  if ((begins?.count ?? 0) >= limits.maxBeginsPerHour) throw new SyncError(429, "rate_limited");
  const stored = await db.prepare("SELECT COALESCE(SUM(total_bytes), 0) AS bytes FROM sync_versions WHERE household_id = ?")
    .bind(household.id).first<{ bytes: number }>();
  if ((stored?.bytes ?? 0) + totalBytes > limits.maxHouseholdBytes) throw new SyncError(507, "storage_limit_exceeded");
}

export async function beginUpload(ctx: SyncContext, household: HouseholdRow, device: DeviceRow, input: BeginInput) {
  assertActive(household);
  const { db, now, limits } = ctx;
  if (input.chunkCount > limits.maxChunkCount || input.totalBytes < input.chunkCount) throw new SyncError(400, "invalid_request");
  if (input.totalBytes > limits.maxCiphertextBytes || input.totalBytes > input.chunkCount * limits.maxChunkBytes) {
    throw new SyncError(413, "version_too_large");
  }
  const bodyHash = await sha256Hex(["begin", device.id, input.versionId, input.baseVersionId ?? "", input.generation, input.chunkCount, input.totalBytes].join("|"));
  const replay = async () => {
    const recorded = await findRequest(db, household.id, input.requestId);
    if (!recorded) return null;
    if (recorded.kind !== "begin" || recorded.body_hash !== bodyHash) throw new SyncError(409, "request_id_reused");
    const version = await getVersion(db, household.id, recorded.version_id);
    if (!version) throw new SyncError(410, "upload_expired");
    return { created: false, ...beginJson(version) };
  };
  const replayed = await replay();
  if (replayed) return replayed;
  if (input.generation !== household.generation) throw new SyncError(409, "generation_mismatch", { generation: household.generation });
  try {
    await checkUploadLimits(ctx, household, input.totalBytes);
  } catch (error) {
    if (!(error instanceof SyncError)) throw error;
    // Expired uploads and old history may be what fills the quota. Reclaim, then check once more.
    await collectSyncGarbage(ctx, { householdId: household.id });
    await checkUploadLimits(ctx, household, input.totalBytes);
  }
  const objectPrefix = crypto.randomUUID();
  const expiresAt = now + limits.unpublishedTtlSeconds * 1000;
  try {
    await db.batch([
      db.prepare(`INSERT INTO sync_versions(id, household_id, parent_version_id, generation, state, chunk_count, total_bytes, object_prefix, created_by_device_id, created_at, expires_at)
        SELECT ?1, ?2, ?3, ?4, 'uploading', ?5, ?6, ?7, ?8, ?9, ?10
        WHERE EXISTS (SELECT 1 FROM sync_households WHERE id = ?2 AND status = 'active' AND generation = ?4)
          AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ?8 AND household_id = ?2 AND revoked_at IS NULL AND generation = ?4)
          AND NOT EXISTS (SELECT 1 FROM sync_requests WHERE household_id = ?2 AND request_id = ?11)`)
        .bind(input.versionId, household.id, input.baseVersionId, input.generation, input.chunkCount, input.totalBytes, objectPrefix, device.id, now, expiresAt, input.requestId),
      db.prepare(`INSERT INTO sync_requests(household_id, request_id, kind, body_hash, outcome, version_id, sequence, created_at)
        SELECT household_id, ?1, 'begin', ?2, 'created', id, NULL, ?3 FROM sync_versions WHERE id = ?4 AND object_prefix = ?5`)
        .bind(input.requestId, bodyHash, now, input.versionId, objectPrefix),
    ]);
  } catch (error) {
    // A concurrent retry of the same request may have committed first.
    const concurrent = await replay();
    if (concurrent) return concurrent;
    if (await db.prepare("SELECT id FROM sync_versions WHERE id = ?").bind(input.versionId).first()) throw new SyncError(409, "version_unavailable");
    throw error;
  }
  const version = await getVersion(db, household.id, input.versionId);
  // The guarded insert records nothing when the household, device, or generation changed meanwhile.
  if (!version || version.object_prefix !== objectPrefix) throw new SyncError(409, "upload_rejected");
  return { created: true, ...beginJson(version) };
}

function beginJson(version: VersionRow) {
  return {
    versionId: version.id, parentVersionId: version.parent_version_id, generation: version.generation,
    chunkCount: version.chunk_count, totalBytes: version.total_bytes, expiresAt: iso(version.expires_at),
  };
}

export interface PutChunkInput {
  versionId: string;
  index: number;
  size: number;
  sha256: string;
  body: ReadableStream<Uint8Array> | null;
}

/** Atomically reserves an object key before crossing the D1/R2 boundary. */
async function beginStorageOperation(ctx: SyncContext, household: HouseholdRow, key: string): Promise<string> {
  const operationId = crypto.randomUUID();
  const result = await ctx.db.prepare(`INSERT INTO sync_storage_operations(id, household_id, object_key, state, created_at)
    SELECT ?1, ?2, ?3, 'pending', ?4
    WHERE EXISTS (SELECT 1 FROM sync_households WHERE id = ?2 AND status = 'active')
      AND NOT EXISTS (SELECT 1 FROM sync_households h JOIN account_deletion_tombstones t ON t.user_id = h.owner_user_id WHERE h.id = ?2)
      AND NOT EXISTS (SELECT 1 FROM sync_storage_operations WHERE object_key = ?3)
      AND NOT EXISTS (SELECT 1 FROM sync_retired_object_keys WHERE object_key = ?3)`)
    .bind(operationId, household.id, key, ctx.now).run();
  if (changes(result) === 1) return operationId;
  const current = await ctx.db.prepare("SELECT status FROM sync_households WHERE id = ?").bind(household.id).first<{ status: string }>();
  if (!current || current.status !== "active") throw new SyncError(409, "household_deleting");
  const deletingAccount = await ctx.db.prepare(`SELECT 1 AS found FROM sync_households h
    JOIN account_deletion_tombstones t ON t.user_id = h.owner_user_id WHERE h.id = ?`).bind(household.id).first();
  if (deletingAccount) throw new SyncError(409, "account_deleting");
  const retired = await ctx.db.prepare("SELECT object_key FROM sync_retired_object_keys WHERE object_key = ?").bind(key).first();
  if (retired) throw new SyncError(410, "chunk_retired");
  throw new SyncError(409, "storage_operation_pending");
}

/**
 * Settles a provider write and either records the chunk or queues its object
 * for deletion, all while the operation row still protects destructive work.
 */
async function finishChunkStorageOperation(
  ctx: SyncContext,
  operationId: string,
  householdId: string,
  versionId: string,
  index: number,
  key: string,
  now: number,
): Promise<boolean> {
  const results = await ctx.db.batch([
    ctx.db.prepare("UPDATE sync_storage_operations SET state = 'settled' WHERE id = ? AND state = 'pending'").bind(operationId),
    ctx.db.prepare(`UPDATE sync_chunks SET state = 'stored'
      WHERE version_id = ?1 AND chunk_index = ?2 AND object_key = ?3 AND state = 'pending'
        AND EXISTS (SELECT 1 FROM sync_storage_operations WHERE id = ?4 AND state = 'settled')
        AND EXISTS (SELECT 1 FROM sync_versions v JOIN sync_households h ON h.id = v.household_id
          WHERE v.id = ?1 AND v.state = 'uploading' AND v.expires_at > ?5
            AND h.id = ?6 AND h.status = 'active' AND h.generation = v.generation)
        AND NOT EXISTS (SELECT 1 FROM sync_households h JOIN account_deletion_tombstones t ON t.user_id = h.owner_user_id WHERE h.id = ?6)`)
      .bind(versionId, index, key, operationId, now, householdId),
    ctx.db.prepare(`INSERT OR IGNORE INTO sync_object_deletions(object_key, household_id)
      SELECT object_key, household_id FROM sync_storage_operations o
      WHERE o.id = ?1 AND o.state = 'settled'
        AND NOT EXISTS (SELECT 1 FROM sync_chunks c WHERE c.version_id = ?2 AND c.chunk_index = ?3 AND c.object_key = ?4 AND c.state = 'stored')`)
      .bind(operationId, versionId, index, key),
    ctx.db.prepare("DELETE FROM sync_storage_operations WHERE id = ? AND state = 'settled'").bind(operationId),
  ]) as Array<{ meta?: { changes?: number } }>;
  return changes(results[1] ?? {}) === 1;
}

/** A rejected provider call has ended; retain a durable delete before releasing the guard. */
async function failStorageOperation(ctx: SyncContext, operationId: string): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare("UPDATE sync_storage_operations SET state = 'settled' WHERE id = ? AND state = 'pending'").bind(operationId),
    ctx.db.prepare(`INSERT OR IGNORE INTO sync_object_deletions(object_key, household_id)
      SELECT object_key, household_id FROM sync_storage_operations WHERE id = ? AND state = 'settled'`).bind(operationId),
    ctx.db.prepare("DELETE FROM sync_storage_operations WHERE id = ? AND state = 'settled'").bind(operationId),
  ]);
}

export async function putChunk(ctx: SyncContext, household: HouseholdRow, device: DeviceRow, input: PutChunkInput) {
  assertActive(household);
  const { db, now, limits } = ctx;
  const version = await getVersion(db, household.id, input.versionId);
  if (!version) throw new SyncError(404, "version_not_found");
  if (version.state !== "uploading") throw new SyncError(409, "version_not_uploading");
  if (version.expires_at <= now) throw new SyncError(410, "upload_expired");
  if (version.generation !== household.generation) throw new SyncError(409, "generation_mismatch", { generation: household.generation });
  if (input.index < 0 || input.index >= version.chunk_count) throw new SyncError(400, "invalid_chunk_index");
  if (input.size < 1) throw new SyncError(400, "invalid_request");
  if (input.size > limits.maxChunkBytes) throw new SyncError(413, "chunk_too_large");

  const key = `${household.id}/${version.object_prefix}/${input.index}`;
  const findChunk = () => db.prepare("SELECT chunk_index, sha256, size_bytes, object_key, state FROM sync_chunks WHERE version_id = ? AND chunk_index = ?")
    .bind(input.versionId, input.index).first<ChunkRow>();
  const sameContent = (chunk: ChunkRow) => chunk.sha256 === input.sha256 && chunk.size_bytes === input.size;

  let chunk = await findChunk();
  if (!chunk) {
    const used = await db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM sync_chunks WHERE version_id = ?").bind(input.versionId).first<{ bytes: number }>();
    if ((used?.bytes ?? 0) + input.size > version.total_bytes) throw new SyncError(413, "chunks_exceed_declared_size");
    try {
      const claimed = await db.prepare(`INSERT INTO sync_chunks(household_id, version_id, chunk_index, sha256, size_bytes, object_key, state, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7
        WHERE EXISTS (SELECT 1 FROM sync_versions v JOIN sync_households h ON h.id = v.household_id
            WHERE v.id = ?2 AND v.state = 'uploading' AND v.expires_at > ?7 AND h.status = 'active' AND h.generation = v.generation)
          AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ?8 AND household_id = ?1 AND revoked_at IS NULL AND generation = ?9)
          AND (SELECT COALESCE(SUM(size_bytes), 0) FROM sync_chunks WHERE version_id = ?2) + ?5 <= ?10`)
        .bind(household.id, input.versionId, input.index, input.sha256, input.size, key, now, device.id, household.generation, version.total_bytes).run();
      if (changes(claimed) !== 1) throw new SyncError(409, "upload_rejected");
    } catch (error) {
      if (error instanceof SyncError) throw error;
      // A parallel retry of the same chunk won the primary key.
      chunk = await findChunk();
      if (!chunk) throw error;
    }
  }
  if (chunk) {
    if (!sameContent(chunk)) throw new SyncError(409, "chunk_conflict");
    if (chunk.state === "stored") {
      await input.body?.cancel();
      return { created: false, index: input.index, size: input.size, sha256: input.sha256 };
    }
  }
  if (!input.body) throw new SyncError(400, "invalid_request");

  const operationId = await beginStorageOperation(ctx, household, key);
  try {
    await ctx.provider.put(key, input.body, { size: input.size, sha256: input.sha256 });
  } catch (error) {
    if (error instanceof SyncStorageConflictError || error instanceof SyncStorageIntegrityError) await failStorageOperation(ctx, operationId);
    // An unknown provider failure can leave the remote outcome undetermined.
    // Keep its durable guard; time alone must never authorize deletion/retry.
    if (error instanceof SyncStorageConflictError) throw new SyncError(409, "chunk_conflict");
    if (error instanceof SyncStorageIntegrityError) throw new SyncError(400, "checksum_mismatch");
    throw error;
  }
  const stored = await finishChunkStorageOperation(ctx, operationId, household.id, input.versionId, input.index, key, now);
  if (!stored) {
    // The household/version changed while the write was in flight. The batch
    // queued the provider object before releasing its deletion guard.
    throw new SyncError(409, "upload_aborted");
  }
  return { created: true, index: input.index, size: input.size, sha256: input.sha256 };
}

/** Shared by the pre-check and by diagnosis when the guarded batch changed nothing. */
async function assertPublishable(ctx: SyncContext, householdId: string, deviceId: string, versionId: string): Promise<VersionRow> {
  const { db, now } = ctx;
  const household = await db.prepare(`SELECT ${HOUSEHOLD_COLUMNS} FROM sync_households WHERE id = ?`).bind(householdId).first<HouseholdRow>();
  if (!household || household.status !== "active") throw new SyncError(409, "household_deleting");
  const device = await db.prepare("SELECT id, household_id, generation, revoked_at FROM sync_devices WHERE id = ? AND household_id = ?").bind(deviceId, householdId).first<DeviceRow>();
  if (!device || device.revoked_at !== null) throw new SyncError(403, "device_revoked");
  if (device.generation !== household.generation) throw new SyncError(403, "device_generation_stale");
  const version = await getVersion(db, householdId, versionId);
  if (!version) throw new SyncError(404, "version_not_found");
  if (version.state !== "uploading") throw new SyncError(409, "version_not_uploading");
  if (version.expires_at <= now) throw new SyncError(410, "upload_expired");
  if (version.generation !== household.generation) throw new SyncError(409, "generation_mismatch", { generation: household.generation });
  return version;
}

function publishJson(row: Pick<RequestRow, "outcome" | "version_id" | "sequence">, currentVersionId: string | null) {
  return { outcome: row.outcome, versionId: row.version_id, sequence: row.sequence, currentVersionId };
}

export async function publishVersion(ctx: SyncContext, household: HouseholdRow, device: DeviceRow, versionId: string, requestId: string) {
  const { db, now } = ctx;
  const bodyHash = await sha256Hex(["publish", device.id, versionId].join("|"));
  const replay = async () => {
    const recorded = await findRequest(db, household.id, requestId);
    if (!recorded) return null;
    if (recorded.kind !== "publish" || recorded.body_hash !== bodyHash) throw new SyncError(409, "request_id_reused");
    const live = await db.prepare("SELECT current_version_id FROM sync_households WHERE id = ?").bind(household.id).first<{ current_version_id: string | null }>();
    return { replayed: true, ...publishJson(recorded, live?.current_version_id ?? null) };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const version = await assertPublishable(ctx, household.id, device.id, versionId);
  const chunks = await db.prepare("SELECT chunk_index, size_bytes FROM sync_chunks WHERE version_id = ? AND state = 'stored' ORDER BY chunk_index")
    .bind(versionId).all<{ chunk_index: number; size_bytes: number }>();
  const complete = chunks.results.length === version.chunk_count
    && chunks.results.every((chunk, index) => chunk.chunk_index === index)
    && chunks.results.reduce((sum, chunk) => sum + chunk.size_bytes, 0) === version.total_bytes;
  if (!complete) throw new SyncError(409, "upload_incomplete");

  const deviceOk = `EXISTS (SELECT 1 FROM sync_devices d WHERE d.id = ?4 AND d.household_id = ?3 AND d.revoked_at IS NULL AND d.generation = sync_households.generation)`;
  const versionOk = `EXISTS (SELECT 1 FROM sync_versions v WHERE v.id = ?1 AND v.household_id = ?3 AND v.state = 'uploading' AND v.expires_at > ?2 AND v.generation = sync_households.generation)`;
  try {
    // One transaction: advance the pointer only if it still equals the recorded
    // base, mark the version published or conflict, and record the request result.
    await db.batch([
      db.prepare(`UPDATE sync_households SET current_version_id = ?1, current_sequence = current_sequence + 1, updated_at = ?2
        WHERE id = ?3 AND status = 'active' AND ${versionOk} AND ${deviceOk}
          AND current_version_id IS (SELECT parent_version_id FROM sync_versions WHERE id = ?1)`)
        .bind(versionId, now, household.id, device.id),
      db.prepare(`UPDATE sync_versions SET
          state = CASE WHEN (SELECT current_version_id FROM sync_households WHERE id = ?3) = ?1 THEN 'published' ELSE 'conflict' END,
          sequence = CASE WHEN (SELECT current_version_id FROM sync_households WHERE id = ?3) = ?1
            THEN (SELECT current_sequence FROM sync_households WHERE id = ?3) END,
          published_at = ?2, publish_request_id = ?5
        WHERE id = ?1 AND household_id = ?3 AND state = 'uploading' AND expires_at > ?2
          AND EXISTS (SELECT 1 FROM sync_households h WHERE h.id = ?3 AND h.status = 'active' AND h.generation = sync_versions.generation)
          AND EXISTS (SELECT 1 FROM sync_devices d WHERE d.id = ?4 AND d.household_id = ?3 AND d.revoked_at IS NULL AND d.generation = sync_versions.generation)`)
        .bind(versionId, now, household.id, device.id, requestId),
      db.prepare(`INSERT INTO sync_requests(household_id, request_id, kind, body_hash, outcome, version_id, sequence, created_at)
        SELECT household_id, ?5, 'publish', ?6, state, id, sequence, ?2 FROM sync_versions
        WHERE id = ?1 AND household_id = ?3 AND publish_request_id = ?5 AND state IN ('published', 'conflict')`)
        .bind(versionId, now, household.id, device.id, requestId, bodyHash),
    ]);
  } catch (error) {
    // A concurrent retry with the same request ID may have committed first.
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw error;
  }
  const recorded = await replay();
  if (recorded) return recorded;
  // Nothing was recorded: the device, generation, or household changed after the pre-check.
  await assertPublishable(ctx, household.id, device.id, versionId);
  throw new SyncError(409, "publish_rejected");
}

/**
 * Revokes a device and moves the household to the next generation. Devices that
 * were not the caller keep the old generation and are refused until they rejoin
 * with the new key. `callerDeviceId` adopts the new generation atomically.
 */
export async function revokeDevice(ctx: SyncContext, household: HouseholdRow, targetDeviceId: string, callerDeviceId: string | null) {
  assertActive(household);
  const { db, now } = ctx;
  const target = await db.prepare("SELECT id, household_id, generation, revoked_at FROM sync_devices WHERE id = ? AND household_id = ?")
    .bind(targetDeviceId, household.id).first<DeviceRow>();
  if (!target) throw new SyncError(404, "device_not_found");
  if (target.revoked_at !== null) return { revoked: true, alreadyRevoked: true, generation: household.generation };
  const next = household.generation + 1;
  await db.batch([
    db.prepare(`UPDATE sync_households SET generation = ?1, updated_at = ?2
      WHERE id = ?3 AND status = 'active' AND generation = ?4
        AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ?5 AND household_id = ?3 AND revoked_at IS NULL)`)
      .bind(next, now, household.id, household.generation, targetDeviceId),
    db.prepare("UPDATE sync_devices SET revoked_at = ?1 WHERE id = ?2 AND household_id = ?3 AND revoked_at IS NULL AND (SELECT generation FROM sync_households WHERE id = ?3) = ?4")
      .bind(now, targetDeviceId, household.id, next),
    db.prepare("UPDATE sync_devices SET generation = ?1 WHERE id = ?2 AND household_id = ?3 AND revoked_at IS NULL AND (SELECT generation FROM sync_households WHERE id = ?3) = ?1")
      .bind(next, callerDeviceId ?? "", household.id),
  ]);
  const revoked = await db.prepare("SELECT revoked_at FROM sync_devices WHERE id = ?").bind(targetDeviceId).first<{ revoked_at: number | null }>();
  // Another revocation moved the generation first; nothing here was applied.
  if (!revoked || revoked.revoked_at === null) throw new SyncError(409, "generation_changed");
  return { revoked: true, alreadyRevoked: false, generation: next };
}

export interface DrainResult { deleted: number; failed: number }

/** Deletes queued provider objects, then their queue rows. Failed objects stay queued. */
export async function drainObjectDeletions(ctx: Pick<SyncContext, "db" | "provider">, options: { householdId?: string; maxObjects?: number } = {}): Promise<DrainResult> {
  const { db, provider } = ctx;
  const result: DrainResult = { deleted: 0, failed: 0 };
  const maxObjects = options.maxObjects ?? 1000;
  while (result.deleted + result.failed < maxObjects) {
    const page = await db.prepare("SELECT object_key FROM sync_object_deletions WHERE (? IS NULL OR household_id = ?) AND NOT EXISTS (SELECT 1 FROM sync_storage_operations o WHERE o.object_key = sync_object_deletions.object_key AND o.state = 'pending') ORDER BY object_key LIMIT 50")
      .bind(options.householdId ?? null, options.householdId ?? null).all<{ object_key: string }>();
    if (page.results.length === 0) break;
    const outcomes = await Promise.allSettled(page.results.map((row) => provider.delete(row.object_key)));
    const done = page.results.filter((_, index) => outcomes[index].status === "fulfilled").map((row) => row.object_key);
    for (const key of done) await db.prepare("DELETE FROM sync_object_deletions WHERE object_key = ?").bind(key).run();
    result.deleted += done.length;
    result.failed += page.results.length - done.length;
    // The same failing rows would come back first; leave them for the next run.
    if (done.length < page.results.length) break;
  }
  return result;
}

export interface GarbageResult extends DrainResult { expiredUploads: number; prunedVersions: number }

/**
 * Removes expired unpublished uploads, history beyond the retention count, and
 * old request records, then deletes the queued provider objects. The current
 * version, conflict versions, retained history, and unexpired uploads are never
 * selected. Not scheduled in this change; callers invoke it explicitly.
 */
export async function collectSyncGarbage(ctx: SyncContext, options: { householdId?: string } = {}): Promise<GarbageResult> {
  const { db, now, limits } = ctx;
  const scope = options.householdId ?? null;
  // A publish that races with this statement either commits first (the version
  // is no longer uploading) or is rejected by its `expires_at > now` guard.
  const expiredWhere = `state = 'uploading' AND expires_at <= ?1 AND (?2 IS NULL OR household_id = ?2)
      AND NOT EXISTS (SELECT 1 FROM sync_chunks c JOIN sync_storage_operations o ON o.object_key = c.object_key
        WHERE c.version_id = sync_versions.id AND o.state = 'pending')`;
  const prunedWhere = `state = 'published' AND sequence IS NOT NULL AND (?2 IS NULL OR household_id = ?2)
      AND sequence < (SELECT current_sequence FROM sync_households h WHERE h.id = sync_versions.household_id) - ?1
      AND id IS NOT (SELECT current_version_id FROM sync_households h WHERE h.id = sync_versions.household_id)
      AND NOT EXISTS (SELECT 1 FROM sync_chunks c JOIN sync_storage_operations o ON o.object_key = c.object_key
        WHERE c.version_id = sync_versions.id AND o.state = 'pending')`;
  // Counts are informational; the DELETE statements below decide what is removed.
  const countOf = async (where: string, first: number) =>
    (await db.prepare(`SELECT COUNT(*) AS count FROM sync_versions WHERE ${where}`).bind(first, scope).first<{ count: number }>())?.count ?? 0;
  const expiredUploads = await countOf(expiredWhere, now);
  const prunedVersions = await countOf(prunedWhere, limits.retainedHistory);
  await db.prepare(`DELETE FROM sync_versions WHERE ${expiredWhere}`).bind(now, scope).run();
  await db.prepare(`DELETE FROM sync_versions WHERE ${prunedWhere}`).bind(limits.retainedHistory, scope).run();
  await db.prepare("DELETE FROM sync_requests WHERE created_at < ?1 AND (?2 IS NULL OR household_id = ?2)")
    .bind(now - limits.requestResultTtlSeconds * 1000, scope).run();
  const drained = await drainObjectDeletions(ctx, { householdId: options.householdId });
  return { ...drained, expiredUploads, prunedVersions };
}

/**
 * Deletes all cloud sync data for the household. New uploads stop and every
 * device is revoked first. The household row (and its tombstone) is removed
 * only after every provider object is gone, so a partial failure is retryable
 * and never reported as success.
 */
export async function deleteHouseholdData(ctx: SyncContext, household: HouseholdRow): Promise<void> {
  const { db, now } = ctx;
  await db.batch([
    db.prepare("UPDATE sync_households SET status = 'deleting', generation = generation + 1, updated_at = ?1 WHERE id = ?2 AND status = 'active'").bind(now, household.id),
    db.prepare("UPDATE sync_devices SET revoked_at = ?1 WHERE household_id = ?2 AND revoked_at IS NULL").bind(now, household.id),
  ]);
  const pending = await db.prepare("SELECT id FROM sync_storage_operations WHERE household_id = ? AND state = 'pending' LIMIT 1")
    .bind(household.id).first<{ id: string }>();
  if (pending) throw new SyncError(409, "storage_operation_pending");
  // Deleting version rows cascades to chunks, whose trigger queues each object.
  await db.prepare("DELETE FROM sync_versions WHERE household_id = ?").bind(household.id).run();
  const drained = await drainObjectDeletions(ctx, { householdId: household.id, maxObjects: 100_000 });
  if (drained.failed > 0) throw new SyncError(503, "deletion_incomplete");
  await db.prepare(`DELETE FROM sync_households WHERE id = ?1 AND status = 'deleting'
    AND NOT EXISTS (SELECT 1 FROM sync_object_deletions WHERE household_id = ?1)`).bind(household.id).run();
  // A late chunk write may have queued another object; the next attempt removes it.
  if (await db.prepare("SELECT id FROM sync_households WHERE id = ?").bind(household.id).first()) throw new SyncError(503, "deletion_incomplete");
}
