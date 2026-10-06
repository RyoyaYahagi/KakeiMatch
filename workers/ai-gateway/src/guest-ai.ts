import type { AccountD1BatchResult, AccountEnv } from "./account-auth";
import { dayKey } from "./receipt-ai-usage";

type Db = AccountEnv["ACCOUNT_DB"];
interface RateLimitBinding { limit(input: { key: string }): Promise<{ success: boolean }> }
export interface GuestEnv {
  ACCOUNT_DB?: Db; AI_GATEWAY_AUTH_SECRET?: string; AI_USER_RATE_LIMIT?: RateLimitBinding;
  TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string;
}
type GuestOptions = { fetchImpl?: typeof fetch; nowSeconds?: () => number };

// A shared address (a home router, or a carrier's) still lets a household start a few guests.
export const GUEST_CREATIONS_PER_ADDRESS_DAILY = 10;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;
// Cloudflare's documented testing secrets return a dummy hostname. Production secrets never match this shape.
const TURNSTILE_TESTING_SECRET = /^[123]x0{31}AA$/;
const GUEST_SECRET = /^[A-Za-z0-9_-]{43}$/;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * An HMAC of the client address keyed by the Tokyo day. It caps use per address
 * without storing the address, and the same address gives a new value each day.
 */
export async function addressDayMac(secret: string, request: Request, now: number): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`address-day\n${dayKey(now)}\n${address}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(secret: string, token: unknown, expectedHostname: string, remoteIp: string | null, fetchImpl: typeof fetch): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (remoteIp) body.set("remoteip", remoteIp);
  const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) });
  if (!response.ok) throw new Error("turnstile_unavailable");
  const result = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
  if (result.success !== true) return false;
  if (TURNSTILE_TESTING_SECRET.test(secret)) return true;
  return result.hostname === expectedHostname && result.action === "guest";
}

/** The guest's user ID for a `Guest <secret>` header, or null. */
export async function guestFromRequest(request: Request, db: Db): Promise<string | null> {
  const match = /^Guest ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match || !GUEST_SECRET.test(match[1])) return null;
  const row = await db.prepare("SELECT user_id AS userId FROM guest_devices WHERE secret_hash = ?")
    .bind(await sha256Hex(match[1])).first<{ userId: string }>();
  return row?.userId ?? null;
}
export function hasGuestAuthorization(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("Guest ");
}
export async function touchGuest(db: Db, userId: string, now: number): Promise<void> {
  await db.prepare("UPDATE guest_devices SET last_used_at = ? WHERE user_id = ?").bind(now, userId).run();
}

/**
 * `/api/ai/guest`: GET tells the PWA whether guests are available and the public
 * Turnstile site key, and POST creates a guest after the bot check.
 */
export async function handleGuestRequest(request: Request, env: GuestEnv, options: GuestOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (request.method === "GET") {
    const siteKey = env.TURNSTILE_SITE_KEY?.trim();
    const available = Boolean(siteKey && env.TURNSTILE_SECRET_KEY && env.ACCOUNT_DB && env.AI_GATEWAY_AUTH_SECRET && env.AI_USER_RATE_LIMIT);
    return json(200, { guestAvailable: available, turnstileSiteKey: available ? siteKey : null });
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== url.origin) return json(403, { error: "forbidden_origin" });
  if (!env.ACCOUNT_DB || !env.AI_GATEWAY_AUTH_SECRET) return json(503, { error: "not_configured" });
  const db = env.ACCOUNT_DB;

  if (!env.TURNSTILE_SECRET_KEY || !env.AI_USER_RATE_LIMIT) return json(503, { error: "not_configured" });
  const addressMac = await addressDayMac(env.AI_GATEWAY_AUTH_SECRET, request, now);
  try {
    if (!(await env.AI_USER_RATE_LIMIT.limit({ key: `guest-create:${addressMac}` })).success) return json(429, { error: "rate_limited" });
  } catch { return json(503, { error: "temporarily_unavailable" }); }
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 4096) return json(413, { error: "request_too_large" });
  let body: unknown;
  try { body = await request.json(); } catch { return json(400, { error: "invalid_request" }); }
  const token = body !== null && typeof body === "object" ? (body as Record<string, unknown>).turnstileToken : undefined;
  let human: boolean;
  try { human = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, url.hostname, request.headers.get("cf-connecting-ip"), options.fetchImpl ?? fetch); } catch { return json(503, { error: "turnstile_unavailable" }); }
  if (!human) return json(403, { error: "bot_check_failed" });

  const userId = crypto.randomUUID();
  const secret = randomSecret();
  const day = dayKey(now);
  const results = await db.batch<AccountD1BatchResult>([
    // The cap and the insert are one statement, so concurrent requests cannot both pass it.
    db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      SELECT ?, 'Guest', ?, 0, ?, ? WHERE (SELECT COUNT(*) FROM guest_devices WHERE created_ip_day_mac = ? AND created_day = ?) < ?`)
      .bind(userId, `${userId}@guest.kakeimatch.invalid`, now * 1000, now * 1000, addressMac, day, GUEST_CREATIONS_PER_ADDRESS_DAILY),
    db.prepare(`INSERT INTO guest_devices (user_id, secret_hash, created_at, created_day, created_ip_day_mac, last_used_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM user WHERE id = ?)`)
      .bind(userId, await sha256Hex(secret), now, day, addressMac, now, userId),
  ]).catch(() => null);
  if (!results || results.some(result => result?.success !== true)) return json(503, { error: "temporarily_unavailable" });
  if ((results[1]?.meta?.changes ?? 0) === 0) return json(429, { error: "guest_limit_reached" });
  return json(201, { guestSecret: secret });
}
