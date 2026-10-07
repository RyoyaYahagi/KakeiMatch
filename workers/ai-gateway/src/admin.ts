import { getAccountSession, type AccountD1Database, type AccountEnv } from "./account-auth";
import { monthBounds } from "./ai-provider-costs";
import { monthKey } from "./receipt-ai-usage";
import { analyzeFeedback, createFeedbackIssue, deleteFeedback, getFeedback, listFeedback, revealFeedbackOriginal, updateFeedbackStatus,
  purgeExpiredFeedback, type FeedbackAnalysisInput, type FeedbackIssueInput, type FeedbackIssueResult, type FeedbackStatus } from "./feedback";

export interface AdminEnv extends AccountEnv {
  ADMIN_USER_IDS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  GITHUB_ISSUES_REPOSITORY?: string;
  GITHUB_ISSUES_TOKEN?: string;
  FEEDBACK_ENCRYPTION_KEY?: string;
}

type AdminResult = { userId: string } | { response: Response };
export type AdminHandlerOptions = {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
  analyzeFeedback?: (input: FeedbackAnalysisInput, adminUserId: string) => Promise<string>;
};
type SqlRow = Record<string, unknown>;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  } });
}

function adminIds(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map(id => id.trim()).filter(Boolean));
}

function decodePart(value: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0))));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function verifyAccessJwt(request: Request, env: AdminEnv, fetchImpl: typeof fetch, now: number): Promise<boolean> {
  const domainValue = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!domainValue && !audience) return true;
  if (!domainValue || !audience) return false;
  let domain: URL;
  try { domain = new URL(domainValue); } catch { return false; }
  if (domain.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain.hostname) || domain.port ||
      domain.pathname !== "/" || domain.search || domain.hash || domain.username || domain.password) return false;
  const token = request.headers.get("cf-access-jwt-assertion") ?? "";
  if (token.length > 16_384) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decodePart(parts[0]); const claims = decodePart(parts[1]);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (claims.iss !== domain.origin || !Array.isArray(audiences) || !audiences.includes(audience) ||
      !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= now ||
      claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now + 30)) return false;
  try {
    const response = await fetchImpl(new URL("/cdn-cgi/access/certs", domain), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const jwks = await readBoundedJson(response, 64 * 1024);
    if (!jwks || typeof jwks !== "object" || !Array.isArray((jwks as { keys?: unknown }).keys)) return false;
    const key = (jwks as { keys: unknown[] }).keys.find((candidate): candidate is JsonWebKey & { kid: string; alg?: string; use?: string } =>
      candidate !== null && typeof candidate === "object" && (candidate as Record<string, unknown>).kid === header.kid);
    if (!key || key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig") return false;
    const publicKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = decodeBytes(parts[2]);
    if (!signature) return false;
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown | null> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) return null;
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return null; }
}

function decodeBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0)); }
  catch { return null; }
}

/** Resolves a server-verified Better Auth session and applies the server-side ID allowlist. */
export async function requireAdmin(request: Request, env: AdminEnv, options: AdminHandlerOptions = {}): Promise<AdminResult> {
  const allowedIds = adminIds(env.ADMIN_USER_IDS);
  if (!env.ACCOUNT_DB || !env.BETTER_AUTH_SECRET || allowedIds.size === 0) return { response: json(503, { error: "admin_not_configured" }) };
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (!await verifyAccessJwt(request, env, options.fetchImpl ?? fetch, now)) return { response: json(403, { error: "access_denied" }) };
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  if (origin !== null && origin !== requestUrl.origin) return { response: json(403, { error: "forbidden_origin" }) };
  let session;
  try { session = await getAccountSession(request, env); }
  catch { return { response: json(503, { error: "temporarily_unavailable" }) }; }
  if (!session) return { response: json(401, { error: "unauthorized" }) };
  if (!allowedIds.has(session.user.id)) return { response: json(403, { error: "forbidden" }) };
  return { userId: session.user.id };
}

async function selectRows<T extends SqlRow>(db: AccountD1Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const statement = db.prepare(sql).bind(...values);
  const [result] = await db.batch<{ success: boolean; results?: unknown[] }>([statement]);
  if (!result?.success || !Array.isArray(result.results)) throw new Error("admin_query_failed");
  return result.results as T[];
}

async function selectRow<T extends SqlRow>(db: AccountD1Database, sql: string, ...values: unknown[]): Promise<T> {
  const rows = await selectRows<T>(db, sql, ...values);
  if (!rows[0]) throw new Error("admin_query_failed");
  return rows[0];
}

function readLimit(value: string | null, fallback = 100, max = 500): number | null {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

async function readJson(request: Request | Response, maxBytes = 4096): Promise<unknown | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return null; }
}

async function overview(db: AccountD1Database, now: number) {
  const todayStart = Math.floor((now + 9 * 3600) / 86400) * 86400 - 9 * 3600;
  const thirtyDaysAgo = now - 30 * 86400;
  const month = monthKey(now);
  const bounds = monthBounds(month)!;
  const [accounts, activity, costs, feedback, recentErrors] = await Promise.all([
    selectRow<{ registered: number }>(db, "SELECT COUNT(*) AS registered FROM user u WHERE NOT EXISTS (SELECT 1 FROM guest_devices g WHERE g.user_id=u.id)"),
    selectRow<{ activeToday: number; activeLast30Days: number; usedAiToday: number; usedAiLast30Days: number }>(db,
      `SELECT COUNT(DISTINCT CASE WHEN dispatched_at>=? THEN user_id END) AS activeToday,
       COUNT(DISTINCT user_id) AS activeLast30Days,
       SUM(CASE WHEN dispatched_at>=? THEN 1 ELSE 0 END) AS usedAiToday,
       COUNT(*) AS usedAiLast30Days FROM ai_provider_cost_events WHERE dispatched_at>=?`, todayStart, todayStart, thirtyDaysAgo),
    selectRow<{ requestsToday: number; requestsLast30Days: number; monthUsdMicros: number; unknownRequests: number; last30DaysRateLimits: number; last30DaysErrors: number }>(db,
      `SELECT SUM(CASE WHEN dispatched_at>=? THEN 1 ELSE 0 END) AS requestsToday,
       COUNT(*) AS requestsLast30Days,
       (SELECT COALESCE(SUM(estimated_cost_usd_micros),0) FROM ai_provider_cost_events WHERE dispatched_at>=? AND dispatched_at<?) AS monthUsdMicros,
       SUM(CASE WHEN metering_status='unknown' THEN 1 ELSE 0 END) AS unknownRequests,
       SUM(CASE WHEN safe_error_code IN ('rate_limited','provider_http_429') THEN 1 ELSE 0 END) AS last30DaysRateLimits,
       SUM(CASE WHEN safe_error_code IS NOT NULL THEN 1 ELSE 0 END) AS last30DaysErrors
       FROM ai_provider_cost_events WHERE dispatched_at>=?`, todayStart, bounds.start, bounds.end, thirtyDaysAgo),
    selectRow<{ open: number }>(db, "SELECT COUNT(*) AS open FROM feedback_submissions WHERE status IN ('new','reviewing')"),
    selectRows<{ code: string; requests: number; lastSeen: number }>(db,
      `SELECT safe_error_code AS code, COUNT(*) AS requests, MAX(dispatched_at) AS lastSeen FROM ai_provider_cost_events
       WHERE dispatched_at>=? AND safe_error_code IS NOT NULL GROUP BY safe_error_code ORDER BY lastSeen DESC LIMIT 10`, thirtyDaysAgo),
  ]);
  return {
    accounts: { ...accounts, activeToday: activity.activeToday ?? 0, activeLast30Days: activity.activeLast30Days ?? 0,
      usedAiToday: activity.usedAiToday ?? 0, usedAiLast30Days: activity.usedAiLast30Days ?? 0 },
    ai: { requestsToday: costs.requestsToday ?? 0, requestsLast30Days: costs.requestsLast30Days ?? 0,
      monthUsdMicros: costs.monthUsdMicros ?? 0, unknownRequests: costs.unknownRequests ?? 0,
      last30DaysErrors: costs.last30DaysErrors ?? 0,
      last30DaysRateLimits: costs.last30DaysRateLimits ?? 0 },
    feedback,
    recentErrors,
  };
}

async function aiCosts(db: AccountD1Database, month: string) {
  const bounds = monthBounds(month);
  if (!bounds) return null;
  const rows = await selectRows<{ provider: string; requests: number; inputTokens: number; outputTokens: number; costUsdMicros: number; unknownRequests: number }>(db,
    `SELECT provider, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens,
     COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(estimated_cost_usd_micros),0) AS costUsdMicros,
     SUM(CASE WHEN metering_status='unknown' THEN 1 ELSE 0 END) AS unknownRequests
     FROM ai_provider_cost_events WHERE dispatched_at>=? AND dispatched_at<? GROUP BY provider`, bounds.start, bounds.end);
  const empty = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0, unknownRequests: 0 });
  const providers = { gemini: empty(), jev: empty() };
  for (const row of rows) if (row.provider === "gemini" || row.provider === "jev") providers[row.provider] = row;
  return { month, currency: "USD", totalUsdMicros: providers.gemini.costUsdMicros + providers.jev.costUsdMicros,
    unknownRequests: providers.gemini.unknownRequests + providers.jev.unknownRequests, providers };
}

async function errors(db: AccountD1Database, now: number, limit: number) {
  return { errors: await selectRows<{ code: string; requests: number; lastSeen: number }>(db,
    `SELECT safe_error_code AS code, COUNT(*) AS requests, MAX(dispatched_at) AS lastSeen FROM ai_provider_cost_events
     WHERE dispatched_at>=? AND safe_error_code IS NOT NULL GROUP BY safe_error_code ORDER BY lastSeen DESC LIMIT ?`, now - 30 * 86400, limit) };
}

async function users(db: AccountD1Database, limit: number) {
  const rows = await selectRows<{ id: string; plan: string; createdAt: number; lastAiUseAt: number | null; aiRequests: number; kind: string; enabled: number }>(db,
    `SELECT u.id, CASE WHEN g.user_id IS NOT NULL THEN 'guest' ELSE COALESCE(e.plan,'free') END AS plan,
      CAST(u.createdAt / 1000 AS INTEGER) AS createdAt, MAX(c.dispatched_at) AS lastAiUseAt,
      COUNT(c.id) AS aiRequests, CASE WHEN g.user_id IS NOT NULL THEN 'guest' ELSE 'registered' END AS kind, 1 AS enabled
     FROM user u LEFT JOIN account_entitlements e ON e.user_id=u.id
     LEFT JOIN guest_devices g ON g.user_id=u.id LEFT JOIN ai_provider_cost_events c ON c.user_id=u.id
     GROUP BY u.id ORDER BY u.createdAt DESC LIMIT ?`, limit);
  return { users: rows.map(row => ({ ...row, enabled: row.enabled === 1 })) };
}

async function auditLog(db: AccountD1Database, limit: number) {
  return { entries: await selectRows<{ adminUserId: string; action: string; targetType: string; targetId: string; createdAt: number }>(db,
    `SELECT admin_user_id AS adminUserId, action, target_type AS targetType, target_id AS targetId, created_at AS createdAt
     FROM admin_audit_log ORDER BY created_at DESC LIMIT ?`, limit) };
}

/** Handles all `/api/admin/*` routes. Every response from this namespace is no-store. */
export async function handleAdminRequest(request: Request, env: AdminEnv, options: AdminHandlerOptions = {}): Promise<Response> {
  const auth = await requireAdmin(request, env, options);
  if ("response" in auth) return auth.response;
  const url = new URL(request.url); const path = url.pathname;
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  try {
    await purgeExpiredFeedback(env.ACCOUNT_DB, now);
    if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return json(403, { error: "forbidden_origin" });
    if (path === "/api/admin/overview") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      return json(200, await overview(env.ACCOUNT_DB, now));
    }
    if (path === "/api/admin/ai/costs") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const month = url.searchParams.get("month") ?? monthKey(now);
      const data = await aiCosts(env.ACCOUNT_DB, month);
      return data ? json(200, data) : json(400, { error: "invalid_month" });
    }
    if (path === "/api/admin/errors") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const limit = readLimit(url.searchParams.get("limit"));
      return limit === null ? json(400, { error: "invalid_limit" }) : json(200, await errors(env.ACCOUNT_DB, now, limit));
    }
    if (path === "/api/admin/users") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const limit = readLimit(url.searchParams.get("limit"));
      return limit === null ? json(400, { error: "invalid_limit" }) : json(200, await users(env.ACCOUNT_DB, limit));
    }
    if (path === "/api/admin/audit") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const limit = readLimit(url.searchParams.get("limit"));
      return limit === null ? json(400, { error: "invalid_limit" }) : json(200, await auditLog(env.ACCOUNT_DB, limit));
    }
    if (path === "/api/admin/feedback") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const limit = readLimit(url.searchParams.get("limit"), 50, 100);
      if (limit === null) return json(400, { error: "invalid_limit" });
      const statusValue = url.searchParams.get("status");
      const statuses = new Set<FeedbackStatus>(["new", "reviewing", "issue_created", "resolved", "dismissed"]);
      if (statusValue && !statuses.has(statusValue as FeedbackStatus)) return json(400, { error: "invalid_status" });
      return json(200, await listFeedback({ db: env.ACCOUNT_DB, adminUserId: auth.userId, limit, now,
        ...(statusValue ? { status: statusValue as FeedbackStatus } : {}) }));
    }
    const feedbackMatch = /^\/api\/admin\/feedback\/([A-Za-z0-9_-]{1,80})(?:\/(original|status|analyze|issue))?$/.exec(path);
    if (feedbackMatch) {
      const [, id, action] = feedbackMatch;
      const base = { db: env.ACCOUNT_DB, adminUserId: auth.userId, id, now };
      if (!action && request.method === "GET") return json(200, { item: await getFeedback(base) });
      if (action === "original" && request.method === "POST") return json(200, await revealFeedbackOriginal({ ...base, encryptionKey: env.FEEDBACK_ENCRYPTION_KEY }));
      if (action === "status" && request.method === "PATCH") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).status !== "string") return json(400, { error: "invalid_request" });
        const status = (body as { status: string }).status;
        if (!["reviewing", "resolved", "dismissed"].includes(status)) return json(400, { error: "invalid_status" });
        return json(200, await updateFeedbackStatus({ ...base, status: status as FeedbackStatus }));
      }
      if (action === "analyze" && request.method === "POST") {
        if (!options.analyzeFeedback) return json(503, { error: "not_configured" });
        return json(200, await analyzeFeedback({ ...base, analyze: payload => options.analyzeFeedback!(payload, auth.userId) }));
      }
      if (action === "issue" && request.method === "POST") {
        const draft = await readJson(request);
        if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
            Object.keys(draft).some(key => key !== "title" && key !== "body") ||
            typeof (draft as Record<string, unknown>).title !== "string" || typeof (draft as Record<string, unknown>).body !== "string") {
          return json(400, { error: "invalid_issue_draft" });
        }
        const repo = env.GITHUB_ISSUES_REPOSITORY;
        const token = env.GITHUB_ISSUES_TOKEN;
        const fetchImpl = options.fetchImpl ?? fetch;
        const createIssue = async (payload: FeedbackIssueInput): Promise<FeedbackIssueResult> => {
          const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
            method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
              "content-type": "application/json", "user-agent": "KakeiMatch", "x-github-api-version": "2022-11-28" },
            body: JSON.stringify({ title: payload.title, body: `${payload.body}\n\n<!-- ${payload.idempotencyMarker} -->` }),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.status !== 201) throw new Error("issue_submission_unknown");
          const result: unknown = await readJson(response, 64 * 1024);
          if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("issue_submission_unknown");
          const issue = result as Record<string, unknown>;
          if (!Number.isSafeInteger(issue.number) || typeof issue.html_url !== "string") throw new Error("issue_submission_unknown");
          return { number: issue.number as number, url: issue.html_url };
        };
        return json(200, await createFeedbackIssue({ ...base, repo: repo ?? "", token,
          draft: { title: (draft as { title: string }).title, body: (draft as { body: string }).body }, createIssue }));
      }
      if (!action && request.method === "DELETE") return json(200, await deleteFeedback(base));
      return json(405, { error: "method_not_allowed" });
    }
    return json(404, { error: "not_found" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "not_found" ? 404 : code === "invalid_status" || code === "invalid_issue_draft" ? 400 : code === "not_configured" ? 503 :
      code === "invalid_provider_response" ? 502 : code === "issue_submission_unknown" ? 409 :
      code === "ai_quota_exceeded" || code === "rate_limited" ? 429 : code === "provider_timeout" ? 504 : 503;
    if (status !== 503 || code === "not_configured") return json(status, { error: status === 503 ? "not_configured" : code });
    return json(503, { error: "temporarily_unavailable" });
  }
}
