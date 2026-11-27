import type { AccountEnv, AccountD1BatchResult } from './account-db';
import type { AppAttestConfig } from './app-attest';
import { addressDayMac, GUEST_CREATIONS_PER_ADDRESS_DAILY } from './guest-ai';
import { dayKey } from './receipt-ai-usage';
import { readRequestBytes } from './request-body';
import { handleRequest as handleAiRequest, issueAiToken, usageSummary, type GatewayEnv } from './worker';

export interface NativeEnv extends GatewayEnv {
  NATIVE_APP_TEAM_ID?: string;
  /** Explicit App ID prefix + bundle ID. The prefix is not inferred from the Team ID. */
  NATIVE_APP_ID?: string;
  NATIVE_APP_ORIGIN?: string;
  NATIVE_APP_RP_ID?: string;
  NATIVE_APP_ATTEST_ENVIRONMENT?: string;
}
type Db = AccountEnv['ACCOUNT_DB'];
type Config = AppAttestConfig & { origin: string; rpId: string };
type KeyRow = { key_id: string; public_key: string; counter: number; guest_user_id: string | null; account_user_id: string | null };
type SessionRow = { token_hash: string; key_id: string; user_id: string; identity: 'guest' | 'account'; expires_at: number };
type Challenge = { id: string; challenge: string; purpose: string; key_id: string; session_hash: string | null };
type Options = { nowSeconds?: () => number; fetchImpl?: typeof fetch };
const SESSION_SECONDS = 14 * 86400;
const CHALLENGE_SECONDS = 120;
const ACCESS_SECONDS = 600;
const AUDIENCE = 'kakeimatch-native-ai';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Passkey, account, contact and cost routes were removed with Better Auth. Old clients get a stable 410.
const RETIRED_NATIVE_PATH = /^\/api\/native\/(passkey\/|auth\/|account\/|contact|ai\/costs$)/;
const utf8 = new TextEncoder();

function json(status: number, value: unknown) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
function configured(request: Request, env: NativeEnv): Config | null {
  try {
    const origin = new URL(env.NATIVE_APP_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== env.NATIVE_APP_ORIGIN || origin.port || origin.username || origin.password
      || origin.origin !== new URL(request.url).origin || origin.origin !== env.CLOUD_ACCOUNT_ORIGIN
      || origin.hostname !== env.NATIVE_APP_RP_ID || !/^[A-Z0-9]{10}$/.test(env.NATIVE_APP_TEAM_ID ?? '')
      || !/^[A-Z0-9]{10}\.jp\.kakeimatch\.ios$/.test(env.NATIVE_APP_ID ?? '')
      || !['development', 'production'].includes(env.NATIVE_APP_ATTEST_ENVIRONMENT ?? '')
      || (origin.hostname === 'kakeimatch.yhgry.workers.dev' && env.NATIVE_APP_ATTEST_ENVIRONMENT !== 'production')) return null;
    return { appId: env.NATIVE_APP_ID!, environment: env.NATIVE_APP_ATTEST_ENVIRONMENT as Config['environment'], origin: origin.origin, rpId: origin.hostname };
  } catch { return null; }
}
// Guest and AI paths need only the account database and the AI secret.
function enabled(env: NativeEnv): env is NativeEnv & { ACCOUNT_DB: Db; AI_GATEWAY_AUTH_SECRET: string } {
  return Boolean(env.ACCOUNT_DB && (env.AI_GATEWAY_AUTH_SECRET?.length ?? 0) >= 32 && env.AI_USER_RATE_LIMIT);
}
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid_encoding');
  const result = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (encode(result) !== value) throw new Error('invalid_encoding');
  return result;
}
function keyId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try { return atob(value).length === 32 && btoa(atob(value)) === value; } catch { return false; }
}
async function hash(bytes: Uint8Array) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)); }
async function tokenHash(token: string) { return encode(await hash(utf8.encode(token))); }
function randomToken() { return encode(crypto.getRandomValues(new Uint8Array(32))); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(body: Record<string, unknown>, allowed: string[]) { return Object.keys(body).every(key => allowed.includes(key)); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const bytes = await readRequestBytes(request, 64 * 1024);
  if (!bytes) return null;
  try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); return object(value) ? value : null; } catch { return null; }
}
async function key(db: Db, id: string, config: Config): Promise<KeyRow | null> {
  return db.prepare(`SELECT key_id, public_key, counter, guest_user_id, account_user_id FROM native_app_keys
    WHERE key_id=? AND origin=? AND app_id=? AND environment=? AND revoked_at IS NULL`)
    .bind(id, config.origin, config.appId, config.environment).first<KeyRow>();
}
async function resolveSession(db: Db, config: Config, now: number, authorization: string | null): Promise<SessionRow | null> {
  const match = /^Native ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
  if (!match) return null;
  return resolveSessionHash(db, config, now, await tokenHash(match[1]));
}
async function resolveSessionHash(db: Db, config: Config, now: number, digest: string): Promise<SessionRow | null> {
  return db.prepare(`SELECT n.* FROM native_sessions n
    JOIN native_app_keys k ON k.key_id=n.key_id JOIN user u ON u.id=n.user_id
    WHERE n.token_hash=? AND n.expires_at>? AND k.revoked_at IS NULL AND k.origin=? AND k.app_id=? AND k.environment=?
      AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=n.user_id)
      AND ((n.identity='guest' AND (k.guest_user_id=n.user_id OR k.account_user_id=n.user_id)) OR (n.identity='account' AND k.account_user_id=n.user_id))`)
    .bind(digest, now, config.origin, config.appId, config.environment).first<SessionRow>();
}
async function newSession(db: Db, id: string, user: string, now: number) {
  const token = randomToken();
  const expiresAt = now + SESSION_SECONDS;
  const result = await db.prepare(`INSERT INTO native_sessions(token_hash,key_id,user_id,identity,created_at,expires_at)
    VALUES (?,?,?,'guest',?,?)`).bind(await tokenHash(token), id, user, now, expiresAt).run();
  if (!result.success || result.meta?.changes !== 1) throw new Error('native_session_failed');
  return { sessionToken: token, expiresAt };
}
async function consume(db: Db, id: unknown, purpose: string, now: number): Promise<Challenge | null> {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  // Consume before checking proof. Failed proofs burn the challenge too; never retry it.
  return db.prepare(`UPDATE native_challenges SET used_at=? WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>?
    RETURNING id,challenge,purpose,key_id,session_hash`)
    .bind(now, id.toLowerCase(), purpose, now).first<Challenge>();
}
async function checkAssertion(db: Db, config: Config, challenge: Challenge, assertion: string): Promise<KeyRow | null> {
  const registered = await key(db, challenge.key_id, config);
  if (!registered) return null;
  let verified;
  let appAttest: typeof import('./app-attest');
  try {
    appAttest = await import('./app-attest');
  } catch {
    console.warn('native_app_attest_assertion_failed', { reason: 'unknown' });
    return null;
  }
  try {
    verified = await appAttest.verifyAssertion({ assertion, publicKey: registered.public_key, clientDataHash: await hash(decode(challenge.challenge)), config, counter: registered.counter });
  } catch (error) {
    // Log only the App Attest reason code and the non-secret authData flags
    // byte. Never log the assertion, key, challenge, token, or identity.
    const message = error instanceof Error ? error.message : '';
    const reason = /^[a-z_]+$/.test(message) ? message : 'unknown';
    const flags = typeof appAttest.AppAttestAssertionError === 'function' && error instanceof appAttest.AppAttestAssertionError
      ? error.flags
      : undefined;
    console.warn('native_app_attest_assertion_failed', flags === undefined ? { reason } : { reason, flags });
    return null;
  }
  // Compare-and-swap prevents concurrent assertions from reusing a counter.
  const update = await db.prepare(`UPDATE native_app_keys SET counter=? WHERE key_id=? AND counter=? AND revoked_at IS NULL`)
    .bind(verified.counter, registered.key_id, registered.counter).run();
  return update.success && update.meta?.changes === 1 ? registered : null;
}
function internalHeaders(request: Request, config: Config) {
  // Never forward caller-controlled cookies, origin, identity, or forwarding headers.
  const headers = new Headers({ origin: config.origin, 'content-type': 'application/json' });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  return headers;
}
function withoutCookies(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie'); headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

/** Public association file: exact HTTPS origin, no redirects, no inferred Team/App ID. */
export function appleAppSiteAssociation(request: Request, env: NativeEnv): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });
  const config = configured(request, env);
  if (!config) return json(404, { error: 'not_found' });
  const response = json(200, { webcredentials: { apps: [config.appId] } });
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: response.headers }) : response;
}

/** Native-only boundary. An Origin header never grants trust and ambient cookies never authenticate. */
export async function handleNativeRequest(request: Request, env: NativeEnv, options: Options = {}): Promise<Response> {
  const url = new URL(request.url);
  const config = configured(request, env);
  if (request.headers.has('origin') || request.headers.has('cookie')) return json(403, { error: 'forbidden_origin' });
  if (RETIRED_NATIVE_PATH.test(url.pathname)) return json(410, { error: 'gone' });
  if (url.pathname === '/api/native/config' && request.method === 'GET') {
    const available = Boolean(config && enabled(env));
    return json(200, { available, rpId: available ? config!.rpId : null, appAttestEnvironment: available ? config!.environment : null });
  }
  if (!config || !enabled(env)) return json(503, { error: 'not_configured' });
  const db = env.ACCOUNT_DB;
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  try {
    const address = await addressDayMac(env.AI_GATEWAY_AUTH_SECRET, request, now);
    if (!(await env.AI_USER_RATE_LIMIT!.limit({ key: `native-boundary:${address}` })).success) return json(429, { error: 'rate_limited' });
    const path = url.pathname;
    if (path === '/api/native/challenge') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const input = await body(request);
      if (!input || !fields(input, ['purpose', 'keyId']) || !keyId(input.keyId) || !['attest', 'guest', 'token'].includes(String(input.purpose))) return json(400, { error: 'invalid_request' });
      const session = input.purpose === 'token' ? await resolveSession(db, config, now, request.headers.get('authorization')) : null;
      if (input.purpose === 'token' && (!session || session.key_id !== input.keyId)) return json(401, { error: 'unauthorized' });
      if (input.purpose !== 'attest' && !await key(db, input.keyId, config)) return json(401, { error: 'unauthorized' });
      if (input.purpose === 'attest' && await db.prepare('SELECT key_id FROM native_app_keys WHERE key_id=?').bind(input.keyId).first()) return json(409, { error: 'key_already_registered' });
      const result = { challengeId: crypto.randomUUID(), challenge: randomToken(), expiresAt: now + CHALLENGE_SECONDS };
      const write = await db.prepare(`INSERT INTO native_challenges(id,challenge,purpose,key_id,session_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(result.challengeId, result.challenge, input.purpose, input.keyId, session?.token_hash ?? null, now, result.expiresAt).run();
      if (!write.success) throw new Error('challenge_write_failed');
      return json(200, result);
    }
    if (path === '/api/native/attest') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const input = await body(request);
      if (!input || !fields(input, ['challengeId', 'keyId', 'attestation']) || !keyId(input.keyId) || !text(input.attestation, 60000)) return json(400, { error: 'invalid_request' });
      const challenge = await consume(db, input.challengeId, 'attest', now);
      if (!challenge || challenge.key_id !== input.keyId) return json(403, { error: 'invalid_proof' });
      let proof;
      try {
        const { verifyAttestation } = await import('./app-attest');
        proof = await verifyAttestation({ attestation: input.attestation, keyId: input.keyId, clientDataHash: await hash(decode(challenge.challenge)), config, now: new Date(now * 1000) });
      } catch { return json(403, { error: 'invalid_proof' }); }
      const saved = await db.prepare(`INSERT INTO native_app_keys(key_id,origin,app_id,environment,public_key,receipt,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key_id) DO NOTHING`)
        .bind(input.keyId, config.origin, config.appId, config.environment, proof.publicKey, proof.receipt, now).run();
      if (!saved.success || saved.meta?.changes !== 1) return json(409, { error: 'key_already_registered' });
      return json(200, { registered: true });
    }
    if (path === '/api/native/guest' || path === '/api/native/ai/token') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const input = await body(request);
      if (!input || !fields(input, ['challengeId', 'keyId', 'assertion']) || !keyId(input.keyId) || !text(input.assertion, 10000)) return json(400, { error: 'invalid_request' });
      const purpose = path.endsWith('/token') ? 'token' : 'guest';
      const session = purpose === 'token' ? await resolveSession(db, config, now, request.headers.get('authorization')) : null;
      if (purpose === 'token' && (!session || session.key_id !== input.keyId)) return json(401, { error: 'unauthorized' });
      const challenge = await consume(db, input.challengeId, purpose, now);
      if (!challenge || challenge.key_id !== input.keyId || challenge.session_hash !== (session?.token_hash ?? null)) return json(403, { error: 'invalid_proof' });
      const registered = await checkAssertion(db, config, challenge, input.assertion);
      if (!registered) return json(403, { error: 'invalid_proof' });
      if (session) {
        const token = randomToken(); const expiresAt = Math.min(now + ACCESS_SECONDS, session.expires_at);
        const saved = await db.prepare(`INSERT INTO native_ai_tokens(token_hash,session_hash,audience,created_at,expires_at) VALUES (?,?,?,?,?)`)
          .bind(await tokenHash(token), session.token_hash, AUDIENCE, now, expiresAt).run();
        if (!saved.success) throw new Error('token_write_failed');
        return json(200, { token, expiresAt });
      }
      // The usage holder is the account once the key is bound; a bound key never creates a second guest.
      let user = registered.account_user_id ?? registered.guest_user_id;
      if (!user) {
        user = crypto.randomUUID();
        const secretDigest = Array.from(await hash(utf8.encode(randomToken())), byte => byte.toString(16).padStart(2, '0')).join('');
        const results = await db.batch<AccountD1BatchResult>([
          db.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt)
            SELECT ?, 'Guest', ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM native_app_keys WHERE key_id=? AND guest_user_id IS NULL AND revoked_at IS NULL)
            AND (SELECT COUNT(*) FROM guest_devices WHERE created_ip_day_mac=? AND created_day=?)<?`)
            .bind(user, `${user}@guest.kakeimatch.invalid`, now * 1000, now * 1000, registered.key_id, address, dayKey(now), GUEST_CREATIONS_PER_ADDRESS_DAILY),
          db.prepare(`INSERT INTO guest_devices(user_id,secret_hash,created_at,created_day,created_ip_day_mac,last_used_at)
            SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user WHERE id=?)`).bind(user, secretDigest, now, dayKey(now), address, now, user),
          db.prepare(`UPDATE native_app_keys SET guest_user_id=? WHERE key_id=? AND guest_user_id IS NULL AND EXISTS(SELECT 1 FROM user WHERE id=?)`).bind(user, registered.key_id, user),
        ]);
        if (results.some(result => result.success !== true)) throw new Error('guest_write_failed');
        if (results[1]?.meta?.changes !== 1) {
          const existing = await key(db, registered.key_id, config);
          if (!existing?.guest_user_id) return json(429, { error: 'guest_limit_reached' });
          user = existing.guest_user_id;
        }
      }
      return json(201, await newSession(db, registered.key_id, user, now));
    }
    return await authenticatedRequest(request, env, db, config, now, options);
  } catch { return json(503, { error: 'temporarily_unavailable' }); }
}

async function authenticatedRequest(request: Request, env: NativeEnv & { ACCOUNT_DB: Db; AI_GATEWAY_AUTH_SECRET: string }, db: Db, config: Config, now: number, options: Options) {
  const url = new URL(request.url);
  const targetPath = url.pathname.replace(/^\/api\/native\//, '/api/');
  const aiPaths = ['/api/ai/gemini', '/api/ai/payroll', '/api/ai/jev', '/api/ai/category-suggestion'];
  if (!aiPaths.includes(targetPath) && targetPath !== '/api/ai/usage') return json(404, { error: 'not_found' });
  if (request.method !== (aiPaths.includes(targetPath) ? 'POST' : 'GET')) return json(405, { error: 'method_not_allowed' });
  let session: SessionRow | null;
  if (aiPaths.includes(targetPath)) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
    if (!match) return json(401, { error: 'unauthorized' });
    const access = await db.prepare(`SELECT session_hash FROM native_ai_tokens WHERE token_hash=? AND audience=? AND expires_at>?`)
      .bind(await tokenHash(match[1]), AUDIENCE, now).first<{ session_hash: string }>();
    session = access ? await resolveSessionHash(db, config, now, access.session_hash) : null;
  } else session = await resolveSession(db, config, now, request.headers.get('authorization'));
  if (!session) return json(401, { error: 'unauthorized' });
  // Read from D1 here rather than forwarded: only the AI routes go through the AI handler.
  if (targetPath === '/api/ai/usage') return json(200, { ...(await usageSummary(db, session.user_id, now, env)), supportId: session.user_id });
  // Stream the unchanged body through existing size/schema/quota/provider/cost guards.
  const headers = internalHeaders(request, config);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType); else headers.delete('content-type');
  headers.set('authorization', `Bearer ${await issueAiToken(session.user_id, env.AI_GATEWAY_AUTH_SECRET, now)}`);
  const target = new URL(targetPath, config.origin); target.search = url.search;
  return withoutCookies(await handleAiRequest(new Request(target, { method: 'POST', headers, body: request.body, duplex: 'half' } as RequestInit), env, options));
}

/** Scheduled cleanup is independent of household data and never revives expired credentials. */
export async function purgeNativeCredentials(db: Db, now: number): Promise<void> {
  const results = await db.batch<AccountD1BatchResult>([
    db.prepare('DELETE FROM native_challenges WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM native_ai_tokens WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM native_sessions WHERE expires_at<=?').bind(now),
  ]);
  if (results.some(result => !result.success)) throw new Error('native_cleanup_failed');
}
