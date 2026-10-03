import type { AccountD1Database, AccountEnv } from "./account-auth";
import { digest, isEmail, isName, json, normalizeEmail, randomToken, readJson, withinRateLimit } from "./account-http";

const SIGNUP_TICKET_LIFETIME_MS = 15 * 60 * 1000;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;
// Cloudflare's documented testing secrets return a dummy hostname. Production secrets never match this shape.
const TURNSTILE_TESTING_SECRET = /^[123]x0{31}AA$/;

export type SignupOptions = { fetchImpl?: typeof fetch; now?: () => number };

type TicketUser = { id: string; name: string; email: string };

async function verifyTurnstile(
  secret: string,
  token: unknown,
  expectedHostname: string,
  remoteIp: string | null,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (remoteIp) body.set("remoteip", remoteIp);
  const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("turnstile_unavailable");
  const result = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
  if (result.success !== true) return false;
  if (TURNSTILE_TESTING_SECRET.test(secret)) return true;
  return result.hostname === expectedHostname && result.action === "signup";
}

/** Public, non-secret settings the PWA needs before showing the signup form. */
export function handleSignupConfigRequest(request: Request, env: AccountEnv): Response {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const available = Boolean(siteKey && env.TURNSTILE_SECRET_KEY && env.ACCOUNT_RATE_LIMIT);
  return json(200, { signupAvailable: available, turnstileSiteKey: available ? siteKey : null });
}

/**
 * Issues a short-lived signup ticket after bot and rate-limit checks.
 *
 * No user row is created here. The account is created only when Better Auth has
 * verified a Passkey for this ticket. Signup never accepts a plan; new accounts
 * have no entitlement row and therefore start as `free`.
 */
export async function handleSignupRequest(request: Request, env: AccountEnv, originUrl: URL, options: SignupOptions = {}): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  if (!env.TURNSTILE_SECRET_KEY) return json(503, { error: "not_configured" });
  const remoteIp = request.headers.get("cf-connecting-ip");
  const limit = await withinRateLimit(env.ACCOUNT_RATE_LIMIT, `signup:${remoteIp ?? "unknown"}`);
  if (limit === "unavailable") return json(503, { error: "temporarily_unavailable" });
  if (limit === "limited") return json(429, { error: "rate_limited" });

  const body = await readJson(request);
  if (!body || !isEmail(body.email) || !isName(body.name)) return json(400, { error: "invalid_request" });
  let human: boolean;
  try {
    human = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body.turnstileToken, originUrl.hostname, remoteIp, options.fetchImpl ?? fetch);
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
  if (!human) return json(400, { error: "bot_check_failed" });

  const email = normalizeEmail(body.email);
  const now = (options.now ?? Date.now)();
  const token = randomToken();
  const expiresAt = now + SIGNUP_TICKET_LIFETIME_MS;
  try {
    // Expired tickets hold an email and name; remove them as soon as possible.
    await env.ACCOUNT_DB.prepare("DELETE FROM account_signup_tickets WHERE expires_at <= ?").bind(now).run();
    const existing = await env.ACCOUNT_DB.prepare("SELECT id FROM user WHERE email = ? LIMIT 1").bind(email).first<{ id: string }>();
    if (existing) return json(409, { error: "email_unavailable" });
    const result = await env.ACCOUNT_DB.prepare(`INSERT INTO account_signup_tickets (id, user_id, token_hash, email, name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), await digest(token), email, body.name.trim(), now, expiresAt).run();
    if (!result.success) throw new Error("signup_ticket_insert_failed");
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
  return json(201, { context: token, expiresAt: new Date(expiresAt).toISOString() });
}

/** Resolves the user to put in Passkey registration options. */
export async function resolveSignupTicket(db: AccountD1Database, tokenHash: string, now: number): Promise<TicketUser | null> {
  return db.prepare(`SELECT user_id AS id, name, email FROM account_signup_tickets
    WHERE token_hash = ? AND expires_at > ? LIMIT 1`).bind(tokenHash, now).first<TicketUser>();
}

/**
 * Creates the account for a verified Passkey and deletes the ticket in one batch.
 * Returns null when the ticket is missing, expired, or already used.
 */
export async function consumeSignupTicket(db: AccountD1Database, tokenHash: string, now: number): Promise<string | null> {
  const ticket = await resolveSignupTicket(db, tokenHash, now);
  if (!ticket) return null;
  const results = await db.batch([
    db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      SELECT user_id, name, email, 0, ?, ? FROM account_signup_tickets
      WHERE token_hash = ? AND user_id = ? AND expires_at > ?`).bind(now, now, tokenHash, ticket.id, now),
    db.prepare("DELETE FROM account_signup_tickets WHERE token_hash = ? AND user_id = ?").bind(tokenHash, ticket.id),
  ]) as Array<{ success?: boolean; meta?: { changes?: number } }>;
  if (results.length !== 2 || results.some((result) => result?.success !== true)) throw new Error("signup_ticket_unavailable");
  return results[0].meta?.changes === 1 ? ticket.id : null;
}
