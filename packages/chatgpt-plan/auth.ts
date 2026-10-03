import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { sessionSchema, type ChatGptRecord, type ChatGptSession, type ChatGptTokenStore } from './token-store';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const permission = 'chatgpt.tokens.use.direct';
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), token_type: z.literal('Bearer'), expires_in: z.number().int().positive().max(86400), scope: z.string().optional(),
});
export class ChatGptPlanError extends Error {
  constructor(readonly code: 'reauthentication_required' | 'permission_required' | 'provider_unavailable' | 'invalid_response' | 'rate_limited') {
    super('ChatGPTへの接続を確認してください。'); this.name = 'ChatGptPlanError';
  }
}
type VerifyIdentity = (token: string, clientId: string, nonce: string) => Promise<string>;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export async function verifyOpenAiIdentity(token: string, clientId: string, nonce: string, keySet: Parameters<typeof jwtVerify>[1] = jwks): Promise<string> {
  const { payload } = await jwtVerify(token, keySet, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5, algorithms: ['RS256'] });
  if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error('Invalid identity');
  return payload.sub;
}
type Pending = { state: string; nonce: string; verifier: string; redirectUri: string; expiresAt: number; clientId?: string; subject?: string };

export class ChatGptPlanAuth {
  private pending?: Pending;
  private epoch = 0;
  private refreshing?: Promise<ChatGptSession>;
  constructor(readonly store: ChatGptTokenStore, readonly fetchImpl = fetch, private readonly verify: VerifyIdentity = verifyOpenAiIdentity, private readonly now = Date.now) {}
  async record(): Promise<ChatGptRecord> {
    const existing = await this.store.read();
    if (existing) return existing;
    const created = { hostId: `urn:uuid:${randomUUID()}`, registration: null, session: null, enabled: false, model: null };
    await this.store.write(created); return created;
  }
  async begin(redirectUri: string): Promise<string> {
    const uri = new URL(redirectUri);
    if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.pathname !== '/auth/callback' || uri.search || uri.hash) throw new ChatGptPlanError('invalid_response');
    const record = await this.record();
    const pending: Pending = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'), redirectUri, expiresAt: this.now() + 5 * 60_000,
      clientId: record.registration?.clientId, subject: record.registration?.subject };
    this.epoch++; this.pending = pending;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    const parameters = { client_id: pending.clientId ?? 'dynamic_agent_client', ext_agent_host_id: record.hostId,
      response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE, state: pending.state, nonce: pending.nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') };
    Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, value));
    if (!pending.clientId) url.searchParams.set('agent_name_hint', 'KakeiMatch');
    return url.href;
  }
  async complete(parameters: URLSearchParams): Promise<void> {
    const pending = this.pending;
    const epoch = this.epoch;
    if (!pending || pending.expiresAt <= this.now() || parameters.getAll('state').length !== 1 || parameters.get('state') !== pending.state) throw new ChatGptPlanError('reauthentication_required');
    this.pending = undefined; // Consume even declined or malformed callbacks; no code replay.
    if (parameters.has('error') || parameters.getAll('code').length !== 1 || !parameters.get('code') || parameters.getAll('client_id').length > 1) throw new ChatGptPlanError('reauthentication_required');
    const clientId = parameters.get('client_id') ?? pending.clientId;
    if (!clientId?.startsWith('oaiapp_') || (pending.clientId && clientId !== pending.clientId)) throw new ChatGptPlanError('invalid_response');
    const token = await this.exchange({ grant_type: 'authorization_code', client_id: clientId, code: parameters.get('code')!, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE });
    if (!token.id_token || !token.refresh_token || !token.scope) throw new ChatGptPlanError('invalid_response');
    let subject: string;
    try { subject = await this.verify(token.id_token, clientId, pending.nonce); } catch { throw new ChatGptPlanError('invalid_response'); }
    if (pending.subject && subject !== pending.subject) throw new ChatGptPlanError('invalid_response');
    const record = await this.record();
    const session = sessionSchema.parse({ clientId, subject, accessToken: token.access_token, refreshToken: token.refresh_token,
      idToken: token.id_token, expiresAt: this.now() + token.expires_in * 1000, scopes: token.scope.split(/\s+/).filter(Boolean) });
    if (epoch !== this.epoch) throw new ChatGptPlanError('reauthentication_required');
    await this.store.write({ ...record, registration: { clientId, subject }, session, enabled: false, model: null });
  }
  private async exchange(form: Record<string, string>) {
    let response: Response;
    try { response = await this.fetchImpl(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000), redirect: 'error' }); }
    catch { throw new ChatGptPlanError('provider_unavailable'); }
    if (!response.ok) throw new ChatGptPlanError(response.status === 400 || response.status === 401 ? 'reauthentication_required' : 'provider_unavailable');
    try { return tokenSchema.parse(await response.json()); } catch { throw new ChatGptPlanError('invalid_response'); }
  }
  async access(): Promise<ChatGptSession> {
    const record = await this.record();
    if (!record.session) throw new ChatGptPlanError('reauthentication_required');
    if (!record.session.scopes.includes(permission)) throw new ChatGptPlanError('permission_required');
    if (record.session.expiresAt > this.now() + 60_000) return record.session;
    if (!this.refreshing) this.refreshing = this.refresh(record).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(record: ChatGptRecord): Promise<ChatGptSession> {
    const before = record.session!;
    try {
      const token = await this.exchange({ grant_type: 'refresh_token', client_id: before.clientId, refresh_token: before.refreshToken, resource: RESOURCE });
      const session = { ...before, accessToken: token.access_token, refreshToken: token.refresh_token ?? before.refreshToken,
        idToken: token.id_token ?? before.idToken, expiresAt: this.now() + token.expires_in * 1000, scopes: token.scope === undefined ? before.scopes : token.scope.split(/\s+/).filter(Boolean) };
      const current = await this.record();
      if (!current.session || current.session.refreshToken !== before.refreshToken) throw new ChatGptPlanError('reauthentication_required');
      await this.store.write({ ...current, session });
      if (!session.scopes.includes(permission)) throw new ChatGptPlanError('permission_required');
      return session;
    } catch (error) {
      if (error instanceof ChatGptPlanError && error.code === 'reauthentication_required') {
        const current = await this.record(); if (current.session?.refreshToken === before.refreshToken) await this.store.write({ ...current, session: null, enabled: false, model: null });
      }
      throw error;
    }
  }
  async signOut(): Promise<boolean> {
    this.epoch++; this.pending = undefined;
    // Finish any serialized refresh before revoking its newest rotating token.
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    const record = await this.record(); let revoked = !record.session;
    if (record.session) {
      try {
        const metadata = await this.fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        const discovery = await metadata.json() as { issuer?: string; revocation_endpoint?: string };
        const endpoint = new URL(discovery.revocation_endpoint ?? '');
        if (!metadata.ok || discovery.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.protocol !== 'https:') throw new Error();
        const response = await this.fetchImpl(endpoint, { method: 'POST', body: new URLSearchParams({ token: record.session.refreshToken, token_type_hint: 'refresh_token', client_id: record.session.clientId }), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        revoked = response.status === 200;
      } catch { revoked = false; }
    }
    await this.store.write({ ...record, session: null, enabled: false, model: null }); return revoked;
  }
}
