import { getAccountSession, type AccountEnv } from "./account-auth";
import {
  SyncError, assertActive, authorizeDevice, beginUpload, collectSyncGarbage, createHousehold, deleteHouseholdData,
  findHouseholdByOwner, getCurrent, hasRecentSignIn, isUuid, joinDevice, listDevices, listVersions, lookupRequest,
  openChunk, publishVersion, putChunk, revokeDevice, syncLimits, versionWithChunks,
  type DeviceRow, type HouseholdRow, type SyncContext, type SyncD1Database, type SyncLimitEnv,
} from "./device-sync";
import { getProtectedKey, putProtectedKey } from "./device-sync-keys";
import { R2SyncStorageProvider, type SyncR2Bucket, type SyncStorageProvider } from "./sync-storage-provider";

export interface SyncApiEnv extends SyncLimitEnv {
  ACCOUNT_DB?: SyncD1Database;
  BETTER_AUTH_SECRET?: string;
  CLOUD_ACCOUNT_ORIGIN?: string;
  /** Private R2 bucket for KakeiMatch Cloud sync objects. Absent unless configured. */
  SYNC_BUCKET?: SyncR2Bucket;
}
export interface SyncApiOptions {
  /** Replaces the R2 provider. Used by tests. */
  provider?: SyncStorageProvider;
  now?: () => number;
}

const MAX_JSON_BYTES = 4 * 1024;
const DEVICE_HEADER = "x-sync-device-credential";

type Auth = "reauth" | "device" | "device_or_reauth";
type Route = { auth: Auth; handle: (call: Call) => Promise<Response> };
interface Call {
  request: Request;
  ctx: SyncContext;
  userId: string;
  household: HouseholdRow | null;
  device: DeviceRow | null;
  params: string[];
  url: URL;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new SyncError(415, "unsupported_media_type");
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_JSON_BYTES) throw new SyncError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new SyncError(400, "invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new SyncError(413, "request_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the shared invalid_request error.
  }
  throw new SyncError(400, "invalid_request");
}

const uuid = (value: unknown): string => {
  if (!isUuid(value)) throw new SyncError(400, "invalid_request");
  return value;
};
const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new SyncError(400, "invalid_request");
  return value;
};

function requireHousehold(call: Call): HouseholdRow {
  if (!call.household) throw new SyncError(404, "household_not_found");
  return call.household;
}
function requireDevice(call: Call): { household: HouseholdRow; device: DeviceRow } {
  if (!call.household || !call.device) throw new SyncError(403, "invalid_device_credential");
  return { household: call.household, device: call.device };
}
async function requireNoBody(request: Request): Promise<void> {
  if (request.body !== null) {
    await request.body.cancel();
    throw new SyncError(400, "invalid_request");
  }
}

const routes: Array<{ method: string; pattern: RegExp; route: Route }> = [
  { method: "POST", pattern: /^\/households$/, route: { auth: "reauth", handle: async (call) => {
    const body = await readJsonBody(call.request);
    return json(201, await createHousehold(call.ctx, call.userId, uuid(body.householdId)));
  } } },
  { method: "DELETE", pattern: /^\/household$/, route: { auth: "reauth", handle: async (call) => {
    await requireNoBody(call.request);
    await deleteHouseholdData(call.ctx, requireHousehold(call));
    return json(200, { deleted: true, localHouseholdDataPreserved: true });
  } } },
  { method: "GET", pattern: /^\/current$/, route: { auth: "device", handle: async (call) =>
    json(200, await getCurrent(call.ctx.db, requireDevice(call).household)) } },
  { method: "POST", pattern: /^\/devices$/, route: { auth: "reauth", handle: async (call) => {
    await requireNoBody(call.request);
    return json(201, await joinDevice(call.ctx, requireHousehold(call)));
  } } },
  { method: "GET", pattern: /^\/devices$/, route: { auth: "device", handle: async (call) => {
    const { household, device } = requireDevice(call);
    return json(200, { devices: await listDevices(call.ctx.db, household, device.id) });
  } } },
  { method: "POST", pattern: /^\/devices\/([0-9a-f-]{36})\/revoke$/, route: { auth: "device_or_reauth", handle: async (call) => {
    await requireNoBody(call.request);
    const targetId = uuid(call.params[0]);
    return json(200, await revokeDevice(call.ctx, requireHousehold(call), targetId, call.device?.id ?? null));
  } } },
  { method: "PUT", pattern: /^\/key$/, route: { auth: "device", handle: async (call) => {
    const { household, device } = requireDevice(call);
    const body = await readJsonBody(call.request);
    return json(200, await putProtectedKey(call.ctx, household, device, integer(body.generation, 1, Number.MAX_SAFE_INTEGER), body.protectedKey));
  } } },
  { method: "GET", pattern: /^\/key$/, route: { auth: "device", handle: async (call) =>
    json(200, await getProtectedKey(call.ctx.db, requireDevice(call).household)) } },
  { method: "POST", pattern: /^\/uploads$/, route: { auth: "device", handle: async (call) => {
    const { household, device } = requireDevice(call);
    const body = await readJsonBody(call.request);
    const limits = call.ctx.limits;
    const result = await beginUpload(call.ctx, household, device, {
      requestId: uuid(body.requestId),
      versionId: uuid(body.versionId),
      baseVersionId: body.baseVersionId === null ? null : uuid(body.baseVersionId),
      generation: integer(body.generation, 1, Number.MAX_SAFE_INTEGER),
      chunkCount: integer(body.chunkCount, 1, limits.maxChunkCount),
      totalBytes: integer(body.totalBytes, 1, Number.MAX_SAFE_INTEGER),
    });
    const { created, ...upload } = result;
    return json(created ? 201 : 200, upload);
  } } },
  { method: "PUT", pattern: /^\/versions\/([0-9a-f-]{36})\/chunks\/(\d{1,4})$/, route: { auth: "device", handle: async (call) => {
    const { household, device } = requireDevice(call);
    const length = call.request.headers.get("content-length");
    // R2 needs a known length so the body can stream through without buffering.
    if (!length || !/^\d{1,12}$/.test(length)) throw new SyncError(411, "length_required");
    const sha256 = call.request.headers.get("x-chunk-sha256") ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SyncError(400, "invalid_request");
    const size = Number(length);
    if (size > call.ctx.limits.maxChunkBytes) {
      await call.request.body?.cancel();
      throw new SyncError(413, "chunk_too_large");
    }
    const result = await putChunk(call.ctx, household, device, { versionId: uuid(call.params[0]), index: Number(call.params[1]), size, sha256, body: call.request.body });
    const { created, ...chunk } = result;
    return json(created ? 201 : 200, chunk);
  } } },
  { method: "POST", pattern: /^\/versions\/([0-9a-f-]{36})\/publish$/, route: { auth: "device", handle: async (call) => {
    const { household, device } = requireDevice(call);
    const body = await readJsonBody(call.request);
    const result = await publishVersion(call.ctx, household, device, uuid(call.params[0]), uuid(body.requestId));
    if (result.outcome === "published") {
      // Keeps history within the retention count. A failure must not undo the publication.
      await collectSyncGarbage(call.ctx, { householdId: household.id }).catch(() => console.warn("sync_gc_failed"));
      return json(200, result);
    }
    return json(409, { error: "conflict", ...result });
  } } },
  { method: "GET", pattern: /^\/versions$/, route: { auth: "device", handle: async (call) => {
    const state = call.url.searchParams.get("state");
    if (state !== null && state !== "published" && state !== "conflict") throw new SyncError(400, "invalid_request");
    return json(200, { versions: await listVersions(call.ctx.db, requireDevice(call).household, state) });
  } } },
  { method: "GET", pattern: /^\/versions\/([0-9a-f-]{36})$/, route: { auth: "device", handle: async (call) =>
    json(200, await versionWithChunks(call.ctx.db, requireDevice(call).household, uuid(call.params[0]))) } },
  { method: "GET", pattern: /^\/versions\/([0-9a-f-]{36})\/chunks\/(\d{1,4})$/, route: { auth: "device", handle: async (call) => {
    const chunk = await openChunk(call.ctx, requireDevice(call).household, uuid(call.params[0]), Number(call.params[1]));
    return new Response(chunk.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream", "content-length": String(chunk.size), "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-chunk-sha256": chunk.sha256,
      },
    });
  } } },
  { method: "GET", pattern: /^\/requests\/([0-9a-f-]{36})$/, route: { auth: "device", handle: async (call) =>
    json(200, await lookupRequest(call.ctx.db, requireDevice(call).household, uuid(call.params[0]))) } },
];

/** Handles same-origin `/api/sync/*`. Every request is authorized from the Better Auth session. */
export async function handleSyncRequest(request: Request, env: SyncApiEnv, options: SyncApiOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/sync/")) return json(404, { error: "not_found" });
  const subpath = url.pathname.slice("/api/sync".length);
  const matches = routes.filter((entry) => entry.pattern.test(subpath));
  if (matches.length === 0) return json(404, { error: "not_found" });
  const match = matches.find((entry) => entry.method === request.method);
  if (!match) return json(405, { error: "method_not_allowed" });

  const origin = request.headers.get("origin");
  const changesState = request.method !== "GET";
  if ((changesState && origin !== url.origin) || (origin !== null && origin !== url.origin)) return json(403, { error: "forbidden_origin" });

  const provider = options.provider ?? (env.SYNC_BUCKET ? new R2SyncStorageProvider(env.SYNC_BUCKET) : null);
  if (!env.ACCOUNT_DB || !env.BETTER_AUTH_SECRET || !provider) return json(503, { error: "not_configured" });

  try {
    // The user comes only from the validated session, never from the URL, headers, or body.
    const session = await getAccountSession(request, env as unknown as AccountEnv);
    if (!session) return json(401, { error: "unauthorized" });
    const ctx: SyncContext = { db: env.ACCOUNT_DB, provider, limits: syncLimits(env), now: (options.now ?? Date.now)() };
    const { route } = match;

    const household = await findHouseholdByOwner(ctx.db, session.user.id);
    const recent = () => hasRecentSignIn(ctx, session.session.id, session.user.id);
    let device: DeviceRow | null = null;
    if (route.auth === "reauth") {
      if (!await recent()) throw new SyncError(403, "recent_sign_in_required");
    } else if (route.auth === "device") {
      if (!household) throw new SyncError(404, "household_not_found");
      assertActive(household);
      device = await authorizeDevice(ctx.db, household, request.headers.get(DEVICE_HEADER));
    } else if (household && request.headers.get(DEVICE_HEADER)) {
      assertActive(household);
      device = await authorizeDevice(ctx.db, household, request.headers.get(DEVICE_HEADER));
    } else if (!await recent()) {
      throw new SyncError(403, "recent_sign_in_required");
    }
    const params = subpath.match(match.pattern)?.slice(1) ?? [];
    return await route.handle({ request, ctx, userId: session.user.id, household, device, params, url });
  } catch (error) {
    if (error instanceof SyncError) return json(error.status, { error: error.code, ...error.details });
    console.warn("sync_unavailable");
    return json(503, { error: "temporarily_unavailable" });
  }
}
