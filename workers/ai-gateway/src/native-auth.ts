import { makeSignature } from 'better-auth/crypto';
import { handleAuthRequest, handleAccountRequest, handleVerifiedNativePasskeyRequest, type AccountEnv, type AccountD1BatchResult } from './account-auth';
import type { AppAttestConfig } from './app-attest';
import { addressDayMac, GUEST_CREATIONS_PER_ADDRESS_DAILY } from './guest-ai';
import { dayKey, guestDayUsage } from './receipt-ai-usage';
import { readRequestBytes } from './request-body';
import { handleRequest as handleAiRequest, issueAiToken, type GatewayEnv } from './worker';

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
type SessionRow = { token_hash: string; key_id: string; user_id: string; identity: 'guest' | 'account'; auth_session_id: string | null; expires_at: number; auth_token: string | null };
type Challenge = { id: string; challenge: string; purpose: string; key_id: string; session_hash: string | null; ceremony_kind: 'authenticate' | 'register' | null; target_user_id: string | null; verification_cookie: string | null };
type Options = { nowSeconds?: () => number; fetchImpl?: typeof fetch };
const SESSION_SECONDS = 14 * 86400;
const CHALLENGE_SECONDS = 120;
const ACCESS_SECONDS = 600;
const AUDIENCE = 'kakeimatch-native-ai';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
function enabled(env: NativeEnv): env is NativeEnv & { ACCOUNT_DB: Db; BETTER_AUTH_SECRET: string; AI_GATEWAY_AUTH_SECRET: string } {
  return Boolean(env.ACCOUNT_DB && (env.BETTER_AUTH_SECRET?.length ?? 0) >= 32 && (env.AI_GATEWAY_AUTH_SECRET?.length ?? 0) >= 32 && env.AI_USER_RATE_LIMIT);
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
  return db.prepare(`SELECT n.*, s.token AS auth_token FROM native_sessions n
    JOIN native_app_keys k ON k.key_id=n.key_id JOIN user u ON u.id=n.user_id
    LEFT JOIN session s ON s.id=n.auth_session_id AND s.userId=n.user_id
    WHERE n.token_hash=? AND n.expires_at>? AND k.revoked_at IS NULL AND k.origin=? AND k.app_id=? AND k.environment=?
      AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id=n.user_id)
      AND ((n.identity='guest' AND k.guest_user_id=n.user_id) OR (n.identity='account' AND s.expiresAt>? AND k.account_user_id=n.user_id))`)
    .bind(digest, now, config.origin, config.appId, config.environment, now * 1000).first<SessionRow>();
}
async function newSession(db: Db, id: string, user: string, now: number, auth?: { id: string; expiresAt: number }) {
  const token = randomToken();
  const expiresAt = Math.min(now + SESSION_SECONDS, auth?.expiresAt ?? Infinity);
  const result = await db.prepare(`INSERT INTO native_sessions(token_hash,key_id,user_id,auth_session_id,identity,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?)`).bind(await tokenHash(token), id, user, auth?.id ?? null, auth ? 'account' : 'guest', now, expiresAt).run();
  if (!result.success || result.meta?.changes !== 1) throw new Error('native_session_failed');
  return { sessionToken: token, expiresAt };
}
async function consume(db: Db, id: unknown, purpose: string, now: number): Promise<Challenge | null> {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  // Consume before checking proof. Failed proofs burn the challenge too; never retry it.
  return db.prepare(`UPDATE native_challenges SET used_at=? WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>?
    RETURNING id,challenge,purpose,key_id,session_hash,ceremony_kind,target_user_id,verification_cookie`)
    .bind(now, id, purpose, now).first<Challenge>();
}
async function checkAssertion(db: Db, config: Config, challenge: Challenge, assertion: string): Promise<KeyRow | null> {
  const registered = await key(db, challenge.key_id, config);
  if (!registered) return null;
  let verified;
  try {
    const { verifyAssertion } = await import('./app-attest');
    verified = await verifyAssertion({ assertion, publicKey: registered.public_key, clientDataHash: await hash(decode(challenge.challenge)), config, counter: registered.counter });
  } catch { return null; }
  // Compare-and-swap prevents concurrent assertions from reusing a counter.
  const update = await db.prepare(`UPDATE native_app_keys SET counter=? WHERE key_id=? AND counter=? AND revoked_at IS NULL`)
    .bind(verified.counter, registered.key_id, registered.counter).run();
  return update.success && update.meta?.changes === 1 ? registered : null;
}
async function internalHeaders(request: Request, config: Config, env: NativeEnv, session?: SessionRow | null, cookie?: string | null) {
  // Never forward caller-controlled cookies, origin, identity, or forwarding headers.
  const headers = new Headers({ origin: config.origin, 'content-type': 'application/json' });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  let signed = '';
  if (session?.auth_token) signed = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.auth_token}.${await makeSignature(session.auth_token, env.BETTER_AUTH_SECRET!)}`)}`;
  const cookies = [signed, cookie].filter(Boolean).join('; ');
  if (cookies) headers.set('cookie', cookies);
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
      let user = registered.guest_user_id;
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
    if (path === '/api/native/passkey/options') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const input = await body(request);
      if (!input || !fields(input, ['kind', 'keyId', 'context', 'name']) || !['authenticate', 'register'].includes(String(input.kind)) || !keyId(input.keyId)
        || (input.context !== undefined && !text(input.context, 100)) || (input.name !== undefined && !text(input.name, 120))) return json(400, { error: 'invalid_request' });
      const registered = await key(db, input.keyId, config);
      if (!registered) return json(401, { error: 'unauthorized' });
      const session = await resolveSession(db, config, now, request.headers.get('authorization'));
      if (request.headers.has('authorization') && (!session || session.identity !== 'account' || session.key_id !== input.keyId)) return json(401, { error: 'unauthorized' });
      if (input.context && (input.kind !== 'register' || session)) return json(400, { error: 'invalid_request' });
      if (input.kind === 'register' && !session && !input.context) return json(401, { error: 'unauthorized' });
      let targetUser = session?.user_id ?? null;
      if (input.context) {
        const invite = await db.prepare(`SELECT user_id FROM account_invite WHERE token_hash=? AND used_at IS NULL AND expires_at>?`)
          .bind(await tokenHash(String(input.context)), Date.now()).first<{ user_id: string }>();
        if (!invite || (registered.account_user_id && registered.account_user_id !== invite.user_id)) return json(403, { error: 'invalid_invite' });
        targetUser = invite.user_id;
      }
      const target = new URL(input.kind === 'register' ? '/api/auth/passkey/generate-register-options' : '/api/auth/passkey/generate-authenticate-options', config.origin);
      if (input.context) target.searchParams.set('context', String(input.context));
      if (input.name) target.searchParams.set('name', String(input.name));
      const response = await handleVerifiedNativePasskeyRequest(new Request(target, { headers: await internalHeaders(request, config, env, session) }), env as AccountEnv);
      if (!response.ok) return json(response.status, { error: 'passkey_failed' });
      const passkeyOptions = await response.json() as Record<string, unknown>;
      if (typeof passkeyOptions.challenge !== 'string' || !TOKEN.test(passkeyOptions.challenge)) throw new Error('invalid_passkey_options');
      // The challenge cookie is held only on the server; no Web credential crosses the boundary.
      const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => /^__Secure-better-auth\.better-auth-passkey=/.test(value));
      if (cookies.length !== 1) throw new Error('missing_challenge_cookie');
      const ceremonyId = crypto.randomUUID();
      const saved = await db.prepare(`INSERT INTO native_challenges(id,challenge,purpose,key_id,session_hash,ceremony_kind,target_user_id,verification_cookie,created_at,expires_at) VALUES (?,?,'passkey',?,?,?,?,?,?,?)`)
        .bind(ceremonyId, passkeyOptions.challenge, input.keyId, session?.token_hash ?? null, input.kind, targetUser, cookies[0], now, now + CHALLENGE_SECONDS).run();
      if (!saved.success) throw new Error('ceremony_write_failed');
      return json(200, { ceremonyId, options: passkeyOptions });
    }
    if (path === '/api/native/passkey/verify') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      const input = await body(request);
      if (!input || !fields(input, ['ceremonyId', 'response', 'name', 'assertion']) || !object(input.response) || !text(input.assertion, 10000)
        || (input.name !== undefined && !text(input.name, 120))) return json(400, { error: 'invalid_request' });
      const ceremony = await consume(db, input.ceremonyId, 'passkey', now);
      if (!ceremony || !ceremony.verification_cookie) return json(403, { error: 'invalid_proof' });
      const session = ceremony.session_hash ? await resolveSessionHash(db, config, now, ceremony.session_hash) : null;
      if (ceremony.session_hash && !session) return json(401, { error: 'unauthorized' });
      const registered = await checkAssertion(db, config, ceremony, input.assertion);
      if (!registered) return json(403, { error: 'invalid_proof' });
      // Claim the invitation's server-resolved target only after App Attest proof,
      // before Better Auth can consume an invite. This also serializes competing
      // invitations on one key. A claim grants no session without a valid Passkey.
      if (ceremony.ceremony_kind === 'register' && ceremony.target_user_id) {
        const claimed = await db.prepare(`UPDATE native_app_keys SET account_user_id=? WHERE key_id=? AND revoked_at IS NULL
          AND (account_user_id IS NULL OR account_user_id=?)`).bind(ceremony.target_user_id, registered.key_id, ceremony.target_user_id).run();
        if (!claimed.success || claimed.meta?.changes !== 1) return json(403, { error: 'key_account_mismatch' });
      }
      // Better Auth checks signed clientDataJSON origin/RP/challenge and verifies the credential.
      // Only the exact HTTPS Web origin is accepted, never an app-scheme or wildcard origin.
      const target = ceremony.ceremony_kind === 'register' ? '/api/auth/passkey/verify-registration' : '/api/auth/passkey/verify-authentication';
      const response = await handleVerifiedNativePasskeyRequest(new Request(new URL(target, config.origin), {
        method: 'POST', headers: await internalHeaders(request, config, env, session, ceremony.verification_cookie),
        body: JSON.stringify({ response: input.response, name: input.name, createSession: true }),
      }), env as AccountEnv);
      if (!response.ok) return json(response.status, { error: 'passkey_failed' });
      const verified = await response.json() as { session?: { id?: unknown; userId?: unknown; expiresAt?: unknown }; user?: { id?: unknown } };
      const user = verified.user?.id; const auth = verified.session;
      if (typeof user !== 'string' || typeof auth?.id !== 'string' || auth.userId !== user || typeof auth.expiresAt !== 'string') throw new Error('missing_verified_session');
      const expiresAt = Math.floor(Date.parse(auth.expiresAt) / 1000);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('invalid_session_expiry');
      const bound = await db.prepare(`UPDATE native_app_keys SET account_user_id=? WHERE key_id=? AND revoked_at IS NULL AND (account_user_id IS NULL OR account_user_id=?)`)
        .bind(user, registered.key_id, user).run();
      if (!bound.success || bound.meta?.changes !== 1) {
        await db.prepare('DELETE FROM session WHERE id=?').bind(auth.id).run();
        return json(403, { error: 'key_account_mismatch' });
      }
      return json(200, await newSession(db, registered.key_id, user, now, { id: auth.id, expiresAt }));
    }
    return await authenticatedRequest(request, env, db, config, now, options);
  } catch { return json(503, { error: 'temporarily_unavailable' }); }
}

async function authenticatedRequest(request: Request, env: NativeEnv & { ACCOUNT_DB: Db; AI_GATEWAY_AUTH_SECRET: string }, db: Db, config: Config, now: number, options: Options) {
  const url = new URL(request.url);
  const targetPath = url.pathname.replace(/^\/api\/native\//, '/api/');
  const aiPaths = ['/api/ai/gemini', '/api/ai/payroll', '/api/ai/jev', '/api/ai/category-suggestion', '/api/contact', '/api/contact/transcribe'];
  const sessionMethods: Record<string, string> = {
    '/api/ai/usage': 'GET', '/api/ai/costs': 'GET', '/api/auth/get-session': 'GET',
    '/api/auth/passkey/list-user-passkeys': 'GET', '/api/auth/passkey/delete-passkey': 'POST',
    '/api/auth/sign-out': 'POST', '/api/account/delete': 'DELETE',
  };
  if (!aiPaths.includes(targetPath) && !sessionMethods[targetPath]) return json(404, { error: 'not_found' });
  if (request.method !== (aiPaths.includes(targetPath) ? 'POST' : sessionMethods[targetPath])) return json(405, { error: 'method_not_allowed' });
  let session: SessionRow | null;
  if (aiPaths.includes(targetPath)) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
    if (!match) return json(401, { error: 'unauthorized' });
    const access = await db.prepare(`SELECT session_hash FROM native_ai_tokens WHERE token_hash=? AND audience=? AND expires_at>?`)
      .bind(await tokenHash(match[1]), AUDIENCE, now).first<{ session_hash: string }>();
    session = access ? await resolveSessionHash(db, config, now, access.session_hash) : null;
  } else session = await resolveSession(db, config, now, request.headers.get('authorization'));
  if (!session) return json(401, { error: 'unauthorized' });
  const accountOnly = targetPath.startsWith('/api/auth/') || targetPath.startsWith('/api/account/') || targetPath === '/api/ai/costs' || targetPath.startsWith('/api/contact');
  if (accountOnly && session.identity !== 'account') return json(401, { error: 'unauthorized' });
  const headers = await internalHeaders(request, config, env, session);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType); else headers.delete('content-type');
  const target = new URL(targetPath, config.origin); target.search = url.search;
  if (aiPaths.includes(targetPath)) {
    headers.set('authorization', `Bearer ${await issueAiToken(session.user_id, env.AI_GATEWAY_AUTH_SECRET, now)}`);
    // Stream the unchanged body through existing size/schema/quota/provider/cost guards.
    return withoutCookies(await handleAiRequest(new Request(target, { method: 'POST', headers, body: request.body, duplex: 'half' } as RequestInit), env, options));
  }
  if (targetPath === '/api/ai/usage' && session.identity === 'guest') {
    const configuredLimit = Number(env.AI_GUEST_DAILY_LIMIT);
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 5;
    const used = await guestDayUsage(db, session.user_id, dayKey(now));
    return json(200, { plan: 'guest', period: 'day', day: dayKey(now), used, limit, remaining: Math.max(0, limit - used) });
  }
  const forwarded = new Request(target, { method: request.method, headers, ...(request.body ? { body: request.body, duplex: 'half' } : {}) } as RequestInit);
  if (targetPath.startsWith('/api/ai/')) return withoutCookies(await handleAiRequest(forwarded, env, options));
  if (targetPath === '/api/account/delete') return withoutCookies(await handleAccountRequest(forwarded, env as AccountEnv));
  const response = await handleAuthRequest(forwarded, env as AccountEnv);
  if (targetPath === '/api/auth/get-session' && response.ok) {
    const result = await response.json() as { session?: Record<string, unknown>; user?: unknown } | null;
    if (!result?.session) return json(401, { error: 'unauthorized' });
    // Preserve the existing model without disclosing a browser session token.
    result.session.token = request.headers.get('authorization')!.slice('Native '.length);
    result.session.id = session.token_hash;
    result.session.expiresAt = new Date(session.expires_at * 1000).toISOString();
    return json(200, result);
  }
  return withoutCookies(response);
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
