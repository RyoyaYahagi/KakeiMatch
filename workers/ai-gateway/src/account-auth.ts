import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";

export interface AccountD1Database {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
    };
  };
  batch<T = unknown>(statements: Array<unknown>): Promise<T[]>;
}
export type AccountD1Statement = ReturnType<ReturnType<AccountD1Database["prepare"]>["bind"]>;
/** One statement's result from `batch`; `results` holds the rows of a SELECT. */
export type AccountD1BatchResult = { success: boolean; meta?: { changes?: number }; results?: unknown[] };

export interface AccountEnv {
  ACCOUNT_DB: AccountD1Database;
  BETTER_AUTH_SECRET?: string;
  ACCOUNT_BOOTSTRAP_SECRET?: string;
  CLOUD_ACCOUNT_ORIGIN?: string;
}

export interface AccountSession {
  user: { id: string; email: string; name: string };
  session: { id: string; expiresAt: Date };
}

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 14;
const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

type InviteRow = { id: string; user_id: string; email: string; name: string };

function configuredOrigin(env: AccountEnv, request: Request): URL | null {
  const requestUrl = new URL(request.url);
  const configured = env.CLOUD_ACCOUNT_ORIGIN;
  if (configured) {
    let allowlisted: URL;
    try {
      allowlisted = new URL(configured);
    } catch {
      return null;
    }
    if (allowlisted.origin !== configured || allowlisted.origin !== requestUrl.origin) return null;
    return allowlisted;
  }
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") return requestUrl;
  return null;
}

function secureEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(bytes));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
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
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
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
          const invite = await env.ACCOUNT_DB.prepare(`
            SELECT i.id, i.user_id, u.email, u.name
            FROM account_invite i JOIN user u ON u.id = i.user_id
            WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?
            LIMIT 1
          `).bind(tokenHash, Date.now()).first<InviteRow>();
          if (!invite) throw new Error("valid_account_invite_required");
          const deleted = await env.ACCOUNT_DB.prepare("SELECT user_id FROM account_deletion_tombstones WHERE user_id=?")
            .bind(invite.user_id).first<{ user_id: string }>();
          if (deleted) throw new Error("deleted_account_id");
          return { id: invite.user_id, name: invite.name, email: invite.email };
        },
        afterVerification: async ({ context }) => {
          // This callback also runs when an authenticated user adds a passkey.
          // Such a registration has no invite context and must follow Better Auth's normal flow.
          if (typeof context !== "string" || context.length > 100) return;
          const tokenHash = await digest(context);
          const result = await env.ACCOUNT_DB.prepare(`
            UPDATE account_invite SET used_at = ?
            WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
          `).bind(Date.now(), tokenHash, Date.now()).run();
          if (!result.success || result.meta?.changes !== 1) throw new Error("account_invite_invalid_or_used");
          const invite = await env.ACCOUNT_DB.prepare(`
            SELECT user_id FROM account_invite WHERE token_hash = ? LIMIT 1
          `).bind(tokenHash).first<{ user_id: string }>();
          if (!invite) throw new Error("account_invite_user_missing");
          return { userId: invite.user_id };
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
  try {
    const result = await createAuth(env, originUrl).api.getSession({ headers: request.headers });
    if (!result) return null;
    return {
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      session: { id: result.session.id, expiresAt: result.session.expiresAt },
    };
  } catch {
    return null;
  }
}

/** Checks that a signed AI token still belongs to an account that can use the service. */
export async function isAccountActive(db: AccountD1Database, userId: string): Promise<boolean> {
  const account = await db.prepare(`SELECT id FROM user
    WHERE id=? AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=?)`)
    .bind(userId, userId).first<{ id: string }>();
  return account !== null;
}

/** Creates a time-limited invite after validating the operator-only bootstrap secret. */
export async function handleAccountRequest(request: Request, env: AccountEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/account/delete") return handleDeleteAccountRequest(request, env);
  if (url.pathname !== "/api/account/invites" && url.pathname !== "/api/account/recovery") return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const originUrl = configuredOrigin(env, request);
  if (!originUrl) return json(403, { error: "untrusted_origin" });
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== originUrl.origin) return json(403, { error: "forbidden_origin" });
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authorization);
  const expectedSecret = env.ACCOUNT_BOOTSTRAP_SECRET;
  if (!expectedSecret || expectedSecret.length < 32 || !match || !secureEqual(match[1], expectedSecret)) {
    return json(401, { error: "unauthorized" });
  }
  const body = await readJson(request);
  if (!body || !isEmail(body.email)) return json(400, { error: "invalid_request" });
  const email = body.email.trim().toLowerCase();
  const isRecovery = url.pathname === "/api/account/recovery";
  const name = isName(body.name) ? body.name.trim() : "";
  const inviteId = crypto.randomUUID();
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token);
  const now = Date.now();
  const expiresAt = now + INVITE_LIFETIME_MS;
  try {
    if (isRecovery) {
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
        `).bind(inviteId, existing.id, tokenHash, now, expiresAt),
      ]);
    } else {
      if (!isName(body.name)) return json(400, { error: "invalid_request" });
      const id = crypto.randomUUID();
      await env.ACCOUNT_DB.prepare(`
        INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES (?, ?, ?, 0, ?, ?)
      `).bind(id, name, email, now, now).run().then((result) => {
        if (!result.success) throw new Error("account_user_insert_failed");
      });
      const result = await env.ACCOUNT_DB.prepare(`
        INSERT INTO account_invite (id, user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(inviteId, id, tokenHash, now, expiresAt).run();
      if (!result.success) throw new Error("account_invite_insert_failed");
    }
  } catch {
    return json(409, { error: "account_already_exists_or_unavailable" });
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

  let account: AccountSession | null;
  try {
    const result = await createAuth(env, originUrl).api.getSession({ headers: request.headers });
    account = result ? {
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      session: { id: result.session.id, expiresAt: result.session.expiresAt },
    } : null;
  } catch {
    return json(503, { error: "temporarily_unavailable" });
  }
  if (!account) return json(401, { error: "unauthorized" });

  try {
    await deleteAccountData(env.ACCOUNT_DB, account.user.id);
    return accountDeletedResponse();
  } catch {
    return json(503, { error: "account_deletion_incomplete" });
  }
}
