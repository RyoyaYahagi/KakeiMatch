import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGptPlanAuth, verifyOpenAiIdentity } from '../../packages/chatgpt-plan/auth';
import { ChatGptPlanClient } from '../../packages/chatgpt-plan/client';
import { EncryptedFileTokenStore, type ChatGptRecord, type ChatGptTokenStore } from '../../packages/chatgpt-plan/token-store';
import { startChatGptPlanServer } from '../../packages/chatgpt-plan/server';

const baseRecord = (): ChatGptRecord => ({ hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001', registration: { clientId: 'oaiapp_synthetic', subject: 'synthetic-subject' }, enabled: true, model: 'synthetic-model',
  session: { clientId: 'oaiapp_synthetic', subject: 'synthetic-subject', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id', expiresAt: Date.now() + 3600_000, scopes: ['chatgpt.tokens.use.direct'] } });
function memoryStore(record: ChatGptRecord | null = null): ChatGptTokenStore {
  return { read: async () => record === null ? null : structuredClone(record), write: async value => { record = structuredClone(value); } };
}
const tokenResponse = (changes = {}) => Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', id_token: 'synthetic-id', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', ...changes });

describe('セルフホスト専用ChatGPT OAuth', () => {
  it('PKCE/state/nonce/loopbackと発行済みclientを検証してから保管する', async () => {
    const store = memoryStore(); const fetchImpl = vi.fn<typeof fetch>(async () => tokenResponse()); const verify = vi.fn(async () => 'synthetic-subject');
    const auth = new ChatGptPlanAuth(store, fetchImpl, verify);
    const first = new URL(await auth.begin('http://127.0.0.1:1455/auth/callback'));
    expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client'); expect(first.searchParams.get('agent_name_hint')).toBe('KakeiMatch');
    expect(first.searchParams.get('code_challenge_method')).toBe('S256'); expect(first.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    await expect(auth.complete(new URLSearchParams({ state: 'wrong', code: 'code', client_id: 'oaiapp_synthetic' }))).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
    await auth.complete(new URLSearchParams({ state: first.searchParams.get('state')!, code: 'synthetic-code', client_id: 'oaiapp_synthetic' }));
    const form = fetchImpl.mock.calls[0][1]!.body as URLSearchParams;
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(first.searchParams.get('code_challenge'));
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback'); expect(form.get('client_id')).toBe('oaiapp_synthetic');
    expect(verify).toHaveBeenCalledWith('synthetic-id', 'oaiapp_synthetic', first.searchParams.get('nonce'));
    expect((await store.read())?.enabled).toBe(false);
    const next = new URL(await auth.begin('http://127.0.0.1:2345/auth/callback'));
    expect(next.searchParams.get('client_id')).toBe('oaiapp_synthetic'); expect(next.searchParams.has('agent_name_hint')).toBe(false);
    expect(next.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'));
    expect(next.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
    await expect(auth.complete(new URLSearchParams({ state: next.searchParams.get('state')!, code: 'x', client_id: 'oaiapp_other' }))).rejects.toThrow();
    await expect(auth.begin('http://localhost:1455/auth/callback')).rejects.toThrow();
  });

  it('署名/issuer/audience/nonce/期限/subjectをJOSEで検証する', async () => {
    const pair = await generateKeyPair('RS256'); const jwk = { ...await exportJWK(pair.publicKey), kid: 'synthetic-key', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (changes = {}) => new SignJWT({ nonce: 'expected', ...changes }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://auth.openai.com').setAudience('oaiapp_synthetic').setSubject('synthetic-subject').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    expect(await verifyOpenAiIdentity(await sign(), 'oaiapp_synthetic', 'expected', keys)).toBe('synthetic-subject');
    await expect(verifyOpenAiIdentity(await sign({ nonce: 'wrong' }), 'oaiapp_synthetic', 'expected', keys)).rejects.toThrow();
    await expect(verifyOpenAiIdentity(await sign(), 'oaiapp_other', 'expected', keys)).rejects.toThrow();
    await expect(verifyOpenAiIdentity(await sign({ azp: 'oaiapp_other' }), 'oaiapp_synthetic', 'expected', keys)).rejects.toThrow();
    const multipleAudience = (azp?: string) => new SignJWT({ nonce: 'expected', ...(azp ? { azp } : {}) }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://auth.openai.com').setAudience(['oaiapp_synthetic', 'another-audience']).setSubject('synthetic-subject').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    await expect(verifyOpenAiIdentity(await multipleAudience(), 'oaiapp_synthetic', 'expected', keys)).rejects.toThrow();
    expect(await verifyOpenAiIdentity(await multipleAudience('oaiapp_synthetic'), 'oaiapp_synthetic', 'expected', keys)).toBe('synthetic-subject');
    const expired = await new SignJWT({ nonce: 'expected' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://auth.openai.com').setAudience('oaiapp_synthetic').setSubject('synthetic-subject').setIssuedAt().setExpirationTime(1).sign(pair.privateKey);
    await expect(verifyOpenAiIdentity(expired, 'oaiapp_synthetic', 'expected', keys)).rejects.toThrow();
    const token = await sign(); await expect(verifyOpenAiIdentity(token.slice(0, -3) + 'aaa', 'oaiapp_synthetic', 'expected', keys)).rejects.toThrow();
  });

  it('許可なし/署名失敗/拒否/再利用callbackではAIを開始しない', async () => {
    const store = memoryStore(); const fetchImpl = vi.fn(async () => tokenResponse({ scope: 'openid' }));
    const auth = new ChatGptPlanAuth(store, fetchImpl, async () => 'subject'); const url = new URL(await auth.begin('http://127.0.0.1:1455/auth/callback'));
    const callback = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code', client_id: 'oaiapp_test' });
    await auth.complete(callback); await expect(auth.access()).rejects.toMatchObject({ code: 'permission_required' }); await expect(auth.complete(callback)).rejects.toThrow();
    const bad = new ChatGptPlanAuth(memoryStore(), fetchImpl, async () => { throw new Error('synthetic token detail'); });
    const next = new URL(await bad.begin('http://127.0.0.1:1455/auth/callback'));
    await expect(bad.complete(new URLSearchParams({ state: next.searchParams.get('state')!, code: 'code', client_id: 'oaiapp_test' }))).rejects.toMatchObject({ code: 'invalid_response', message: 'ChatGPTへの接続を確認してください。' });
  });

  it('refreshを直列化して交換tokenを一緒に保管し失効時は再認証を要求する', async () => {
    const record = baseRecord(); record.session!.expiresAt = 1; const store = memoryStore(record);
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { await new Promise(resolve => setTimeout(resolve, 10)); expect((init!.body as URLSearchParams).has('scope')).toBe(false); return tokenResponse(); });
    const auth = new ChatGptPlanAuth(store, fetchImpl); await Promise.all([auth.access(), auth.access()]); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await store.read())?.session).toMatchObject({ accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh' });
    const invalidStore = memoryStore(record); const invalid = new ChatGptPlanAuth(invalidStore, async () => new Response('', { status: 400 }));
    await expect(invalid.access()).rejects.toMatchObject({ code: 'reauthentication_required' }); expect((await invalidStore.read())?.session).toBeNull(); expect((await invalidStore.read())?.enabled).toBe(false);
  });

  it('遠隔revocation失敗でも秘密を削除しhostと登録情報を保持する', async () => {
    const store = memoryStore(baseRecord()); const auth = new ChatGptPlanAuth(store, async () => { throw new Error('synthetic provider body'); });
    expect(await auth.signOut()).toBe(false); const record = await store.read(); expect(record?.session).toBeNull(); expect(record?.registration?.clientId).toBe('oaiapp_synthetic'); expect(record?.enabled).toBe(false);
    expect(JSON.stringify(record)).not.toContain('synthetic-access');
  });

  it('tokenファイルは暗号文/0600/原子的更新で、誤った鍵と改ざんを拒否する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kakeimatch-token-test-')); const path = join(directory, 'credential.enc');
    try {
      const store = new EncryptedFileTokenStore(path, '12'.repeat(32), process.cwd()); await store.write(baseRecord());
      const content = await readFile(path); expect(content.toString()).not.toContain('synthetic-access'); expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await store.read())?.session?.accessToken).toBe('synthetic-access');
      await expect(new EncryptedFileTokenStore(path, '34'.repeat(32), process.cwd()).read()).rejects.toThrow('Protected credentials cannot be verified');
      content[content.length - 1] ^= 1; await writeFile(path, content); await expect(store.read()).rejects.toThrow();
      expect(() => new EncryptedFileTokenStore(join(process.cwd(), 'credentials.enc'), '12'.repeat(32), process.cwd())).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('ChatGPT Plan Preview adapterとloopback境界', () => {
  const completed = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"synthetic":true}' }] }] } };
  it('account固有モデルを使いstore:false/stream:trueで完了eventのみを返す', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async url => String(url).endsWith('/models') ? Response.json({ models: [{ slug: 'synthetic-model', display_name: 'Synthetic', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] }) : new Response(`data: ${JSON.stringify(completed)}\r\n\r\ndata: [DONE]\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } }));
    const client = new ChatGptPlanClient(new ChatGptPlanAuth(memoryStore(baseRecord())), fetchImpl);
    expect(await client.jsonResponse({ instructions: 'synthetic', content: [{ type: 'input_text', text: 'test' }] })).toEqual({ synthetic: true });
    const request = JSON.parse(fetchImpl.mock.calls[1][1]!.body as string); expect(request).toMatchObject({ store: false, stream: true, model: 'synthetic-model' });
    for (const field of ['temperature', 'max_output_tokens', 'previous_response_id', 'metadata', 'background']) expect(request).not.toHaveProperty(field);
  });
  it.each(['response.incomplete', 'response.failed', 'error', 'response.output_text.delta'])('未完了/失敗 %s の結果を保存しない', async type => {
    const client = new ChatGptPlanClient(new ChatGptPlanAuth(memoryStore(baseRecord())), async url => String(url).endsWith('/models') ? Response.json({ models: [{ slug: 'synthetic-model', display_name: 'Synthetic', visibility: 'list' }] }) : new Response(`data: ${JSON.stringify({ type, delta: 'partial-secret' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    await expect(client.jsonResponse({ instructions: 'test', content: [] })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('他origin/偽Host/通常formを拒否しstatusへtokenを返さない', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kakeimatch-loopback-test-')); await writeFile(join(directory, 'index.html'), '<!doctype html>synthetic');
    const auth = new ChatGptPlanAuth(memoryStore(baseRecord())); const { server, origin } = await startChatGptPlanServer({ auth, client: new ChatGptPlanClient(auth), assetsDirectory: directory, port: 0 });
    try {
      const status = await fetch(`${origin}/api/self-hosted/chatgpt/status`); expect(await status.text()).not.toContain('synthetic-access'); expect(status.headers.get('cache-control')).toBe('no-store');
      const rejectedHeaders: Array<Record<string, string>> = [{ origin: 'https://other.example', 'content-type': 'application/json', 'x-kakeimatch-self-hosted': '1' }, { origin, 'content-type': 'application/json' }, { origin, 'content-type': 'text/plain', 'x-kakeimatch-self-hosted': '1' }];
      for (const headers of rejectedHeaders) expect((await fetch(`${origin}/api/self-hosted/chatgpt/sign-in`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
      const fakeHostStatus = await new Promise<number>((accept, reject) => { const request = httpRequest(origin, { headers: { Host: 'attacker.example' } }, response => { response.resume(); accept(response.statusCode!); }); request.on('error', reject); request.end(); });
      expect(fakeHostStatus).toBe(403);
      expect((await fetch(`${origin}/api/self-hosted/chatgpt/sign-in`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-kakeimatch-self-hosted': '1' }, body: '{}' })).status).toBe(200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });
});
