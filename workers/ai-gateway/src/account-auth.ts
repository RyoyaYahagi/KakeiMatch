import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import {
  configuredOrigin as resolveOrigin, digest, hasOperatorSecret, isEmail, json, normalizeEmail, randomToken, readJson,
  withinRateLimit, type RateLimitBinding,
} from "./account-http";
import { consumeSignupTicket, handleSignupConfigRequest, handleSignupRequest, resolveSignupTicket, type SignupOptions } from "./account-signup";
import { acceptFamilyInvite, createFamilyInvite, familyMaxAccounts } from "./family-invites";

export interface AccountD1Database {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
    };
  };
  batch<T = unknown>(statements: Array<unknown>): Promise<T[]>;
}

export interface AccountEnv {
  ACCOUNT_DB: AccountD1Database;
  BETTER_AUTH_SECRET?: string;
  ACCOUNT_BOOTSTRAP_SECRET?: string;
  CLOUD_ACCOUNT_ORIGIN?: string;
  /** Shared limiter for signup, Family invite issue, and Family invite acceptance. */
  ACCOUNT_RATE_LIMIT?: RateLimitBinding;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  FAMILY_MAX_ACCOUNTS?: string;
}

export interface AccountSession {
  user: { id: string; email: string; name: string };
  session: { id: string; expiresAt: Date };
}

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 14;
const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;
const RECOVERY_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type InviteRow = { id: string; user_id: string; email: string; name: string };

function configuredOrigin(env: AccountEnv, request: Request): URL | null {
  return resolveOrigin(env.CLOUD_ACCOUNT_ORIGIN, request);
}

function accountDeletedResponse() {
  return json(200, { deleted: true, localHouseholdDataPreserved: true });
}

export async function deleteAccountData(db: AccountD1Database, userId: string): Promise<void> {
  const results = await db.batch([
    db.prepare(`INSERT INTO account_deletion_tombstones(user_id)
      SELECT id FROM user WHERE id=? ON CONFLICT(user_id) DO NOTHING`).bind(userId),
    db.prepare(`DELETE FROM verification WHERE identifier=(SELECT email FROM user WHERE id=?)`).bind(userId),
    db.prepare(`DELETE FROM user WHERE id=?
      AND EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=?)`).bind(userId, userId),
  ]) as Array<{ success?: boolean; meta?: { changes?: number } }>;
  if (results.length !== 3 || results.some((result) => result?.success !== true)) throw new Error("account_deletion_failed");
  // D1 batches are atomic. A successful batch has written the tombstone and
  // deleted the account; avoid a follow-up read that could fail after commit.
}

function authSecret(env: AccountEnv): string {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  return env.BETTER_AUTH_SECRET;
}

function createAuth(env: AccountEnv, originUrl: URL) {
  const origin = originUrl.origin;
  const rpID = originUrl.hostname;
  return betterAuth({
    appName: "KakeiMatch",
    baseURL: origin,
    secret: authSecret(env),
    database: env.ACCOUNT_DB as never,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_REFRESH_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: originUrl.protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, secure: originUrl.protocol === "https:", sameSite: "lax" },
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    plugins: [passkey({
      rpID,
      rpName: "KakeiMatch",
      origin,
      registration: {
        requireSession: false,
        resolveUser: async ({ context }) => {
          if (typeof context !== "string" || context.length > 100) throw new Error("valid_account_invite_required");
          const tokenHash = await digest(context);
          const now = Date.now();
          // Operator recovery invites point at an existing user. Signup tickets
          // describe a user that is created only after Passkey verification.
          const invite = await env.ACCOUNT_DB.prepare(`
            SELECT i.id, i.user_id, u.email, u.name
            FROM account_invite i JOIN user u ON u.id = i.user_id
            WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?
            LIMIT 1
          `).bind(tokenHash, now).first<InviteRow>();
          const user = invite
            ? { id: invite.user_id, name: invite.name, email: invite.email }
            : await resolveSignupTicket(env.ACCOUNT_DB, tokenHash, now);
          if (!user) throw new Error("valid_account_invite_required");
          const deleted = await env.ACCOUNT_DB.prepare("SELECT user_id FROM account_deletion_tombstones WHERE user_id=?")
            .bind(user.id).first<{ user_id: string }>();
          if (deleted) throw new Error("deleted_account_id");
          return user;
        },
        afterVerification: async ({ context }) => {
          // This callback also runs when an authenticated user adds a passkey.
          // Such a registration has no invite context and must follow Better Auth's normal flow.
          if (typeof context !== "string" || context.length > 100) return;
          const tokenHash = await digest(context);
          const now = Date.now();
          const result = await env.ACCOUNT_DB.prepare(`
            UPDATE account_invite SET used_at = ?
            WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
          `).bind(now, tokenHash, now).run();
          if (!result.success) throw new Error("account_invite_invalid_or_used");
          if (result.meta?.changes === 1) {
            const invite = await env.ACCOUNT_DB.prepare(`
              SELECT user_id FROM account_invite WHERE token_hash = ? LIMIT 1
            `).bind(tokenHash).first<{ user_id: string }>();
            if (!invite) throw new Error("account_invite_user_missing");
            return { userId: invite.user_id };
          }
          const userId = await consumeSignupTicket(env.ACCOUNT_DB, tokenHash, now);
          if (!userId) throw new Error("account_invite_invalid_or_used");
          return { userId };
        },
      },
    })],
  });
}

/** Handles Better Auth's `/api/auth/*` passkey, session, and logout endpoints. */
export async function handleAuthRequest(request: Request, env: AccountEnv): Promise<Response> {
  const originUrl = configuredOrigin(env, request);
  if (!originUrl) return json(403, { error: "untrusted_origin" });
  const headerOrigin = request.headers.get("origin");
  if (headerOrigin && headerOrigin !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  try {
    return await createAuth(env, originUrl).handler(request);
  } catch {
    return json(503, { error: "account_auth_unavailable" });
  }
}

/** Resolves a live Better Auth session from its HttpOnly cookie. */
export async function getAccountSession(request: Request, env: AccountEnv): Promise<AccountSession | null> {
  const originUrl = configuredOrigin(env, request);
  if (!originUrl) return null;
  const lookup = await lookupSession(env, originUrl, request);
  return lookup.status === "ok" ? lookup.account : null;
}

/** Checks that a signed AI token still belongs to an account that can use the service. */
export async function isAccountActive(db: AccountD1Database, userId: string): Promise<boolean> {
  const account = await db.prepare(`SELECT id FROM user
    WHERE id=? AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=?)`)
    .bind(userId, userId).first<{ id: string }>();
  return account !== null;
}

type SessionLookup = { status: "ok"; account: AccountSession } | { status: "none" | "unavailable" };

async function lookupSession(env: AccountEnv, originUrl: URL, request: Request): Promise<SessionLookup> {
  try {
    const result = await createAuth(env, originUrl).api.getSession({ headers: request.headers });
    if (!result) return { status: "none" };
    return {
      status: "ok",
      account: {
        user: { id: result.user.id, email: result.user.email, name: result.user.name },
        session: { id: result.session.id, expiresAt: result.session.expiresAt },
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Routes `/api/account/*`: public signup, Family invites, operator recovery, and self-deletion. */
export async function handleAccountRequest(request: Request, env: AccountEnv, options: SignupOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/account/delete") return handleDeleteAccountRequest(request, env);
  if (url.pathname === "/api/account/signup-config") return handleSignupConfigRequest(request, env);
  const known = ["/api/account/signup", "/api/account/family-invites", "/api/account/family-invites/accept", "/api/account/recovery"];
  if (!known.includes(url.pathname)) return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const originUrl = configuredOrigin(env, request);
  if (!originUrl) return json(403, { error: "untrusted_origin" });
  if (url.pathname === "/api/account/signup") return handleSignupRequest(request, env, originUrl, options);
  if (url.pathname === "/api/account/family-invites/accept") return handleFamilyInviteAccept(request, env, originUrl, options);

  // Operator-only routes. Operator scripts send no Origin header; browsers on other origins do.
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  if (!hasOperatorSecret(request, env.ACCOUNT_BOOTSTRAP_SECRET)) return json(401, { error: "unauthorized" });
  if (url.pathname === "/api/account/family-invites") return handleFamilyInviteIssue(request, env, originUrl, options);
  return handleRecoveryRequest(request, env, originUrl);
}

async function handleFamilyInviteIssue(request: Request, env: AccountEnv, originUrl: URL, options: SignupOptions): Promise<Response> {
  const limit = await withinRateLimit(env.ACCOUNT_RATE_LIMIT, "family-invite-issue");
  if (limit === "unavailable") return json(503, { error: "temporarily_unavailable" });
  if (limit === "limited") return json(429, { error: "rate_limited" });
  const body = await readJson(request);
  if (!body || (body.email !== undefined && body.email !== null && !isEmail(body.email))) return json(400, { error: "invalid_request" });
  const targetEmail = typeof body.email === "string" ? normalizeEmail(body.email) : null;
  try {
    const invite = await createFamilyInvite(env.ACCOUNT_DB, targetEmail, (options.now ?? Date.now)());
    // The token is in the fragment, so browsers do not send it to the server or in Referer headers.
    return json(201, {
      inviteUrl: `${originUrl.origin}/#family-invite=${invite.token}`,
      expiresAt: new Date(invite.expiresAt).toISOString(),
      targetEmail,
    });
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
}

async function handleFamilyInviteAccept(request: Request, env: AccountEnv, originUrl: URL, options: SignupOptions): Promise<Response> {
  if (request.headers.get("origin") !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  const lookup = await lookupSession(env, originUrl, request);
  if (lookup.status !== "ok") {
    return lookup.status === "none" ? json(401, { error: "unauthorized" }) : json(503, { error: "temporarily_unavailable" });
  }
  const { user } = lookup.account;
  const limit = await withinRateLimit(env.ACCOUNT_RATE_LIMIT, `family-accept:${user.id}`);
  if (limit === "unavailable") return json(503, { error: "temporarily_unavailable" });
  if (limit === "limited") return json(429, { error: "rate_limited" });
  // Only the token is read from the body. The user is always the session user.
  const body = await readJson(request);
  if (!body) return json(400, { error: "invalid_request" });
  try {
    const result = await acceptFamilyInvite(env.ACCOUNT_DB, { userId: user.id, email: user.email }, body.token, {
      now: (options.now ?? Date.now)(),
      maxFamilyAccounts: familyMaxAccounts(env.FAMILY_MAX_ACCOUNTS),
    });
    if (result.status === "granted") return json(200, { plan: "family" });
    if (result.status === "already_family") return json(200, { plan: "family", alreadyFamily: true });
    if (result.status === "limit_reached") return json(409, { error: "family_limit_reached" });
    return json(400, { error: "invalid_family_invite" });
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
}

/** Revokes every authenticator and session, then issues a one-time Passkey re-registration invite. */
async function handleRecoveryRequest(request: Request, env: AccountEnv, originUrl: URL): Promise<Response> {
  const body = await readJson(request);
  if (!body || !isEmail(body.email)) return json(400, { error: "invalid_request" });
  const email = normalizeEmail(body.email);
  const token = randomToken();
  const tokenHash = await digest(token);
  const now = Date.now();
  const expiresAt = now + RECOVERY_INVITE_LIFETIME_MS;
  try {
    const existing = await env.ACCOUNT_DB.prepare("SELECT id FROM user WHERE email = ? LIMIT 1")
      .bind(email).first<{ id: string }>();
    if (!existing) return json(404, { error: "account_not_found" });
    // Recovery is an operator action: old sessions and every authenticator are revoked.
    // D1 batch executes the statements atomically.
    await env.ACCOUNT_DB.batch([
      env.ACCOUNT_DB.prepare("DELETE FROM session WHERE userId = ?").bind(existing.id),
      env.ACCOUNT_DB.prepare("DELETE FROM passkey WHERE userId = ?").bind(existing.id),
      env.ACCOUNT_DB.prepare("UPDATE account_invite SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
        .bind(now, existing.id),
      env.ACCOUNT_DB.prepare(`
        INSERT INTO account_invite (id, user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), existing.id, tokenHash, now, expiresAt),
    ]);
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
  return json(201, {
    context: token,
    expiresAt: new Date(expiresAt).toISOString(),
    inviteUrl: `${originUrl.origin}/?invite=${encodeURIComponent(token)}`,
  });
}

async function handleDeleteAccountRequest(request: Request, env: AccountEnv): Promise<Response> {
  if (request.method !== "DELETE") return json(405, { error: "method_not_allowed" });
  const originUrl = configuredOrigin(env, request);
  if (!originUrl) return json(403, { error: "untrusted_origin" });
  if (request.headers.get("origin") !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  if (request.body !== null) return json(400, { error: "invalid_request" });

  const lookup = await lookupSession(env, originUrl, request);
  if (lookup.status !== "ok") {
    return lookup.status === "none" ? json(401, { error: "unauthorized" }) : json(503, { error: "temporarily_unavailable" });
  }

  try {
    await deleteAccountData(env.ACCOUNT_DB, lookup.account.user.id);
    return accountDeletedResponse();
  } catch {
    return json(503, { error: "account_deletion_incomplete" });
  }
}
