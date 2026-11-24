import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAdminGatewayRequest, type GatewayEnv } from './worker';
import { ADMIN_OPERATOR_PRINCIPAL_ID, type AdminEnv } from './admin';
import { submitContactToInbox } from './feedback';
import { sqliteD1 } from './test-support/sqlite-d1';

const now = Date.parse('2026-10-08T03:00:00Z') / 1000;
const origin = 'https://admin.example.test';
const teamDomain = 'https://example.cloudflareaccess.com';
const audience = 'admin-aud';
const key = Buffer.alloc(32, 7).toString('base64url');

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function createAccessFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] };
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
  const payload = encode({ iss: teamDomain, aud: [audience], exp: now + 60, email: 'operator@example.test', sub: 'op-sub-1' });
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return { jwt: `${header}.${payload}.${btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`, jwks };
}

describe('metered admin feedback analysis', () => {
  let sqlite: DatabaseSync; let env: GatewayEnv & AdminEnv; let feedbackId: string; let jwt: string; let jwks: unknown;
  beforeEach(async () => {
    ({ jwt, jwks } = await createAccessFixture());
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
    sqlite.exec("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-reporter','Synthetic','reporter@example.test',0,0)");
    env = {
      ACCOUNT_DB: sqliteD1(sqlite),
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: audience,
      ADMIN_ACCESS_EMAILS: 'operator@example.test',
      AI_GATEWAY_AUTH_SECRET: 'synthetic-signing-secret',
      GEMINI_API_KEY: 'synthetic-provider-key',
      FEEDBACK_ENCRYPTION_KEY: key,
      CONTACT_RATE_LIMIT: { limit: async () => ({ success: true }) },
    };
    const result = await submitContactToInbox({
      db: env.ACCOUNT_DB, user: 'synthetic-reporter', flowId: crypto.randomUUID(),
      inputMac: 'synthetic-mac', kind: 'bug', message: '保存できません。secret=private-value email=person@example.test', encryptionKey: key, now,
    });
    feedbackId = result.feedbackId;
  });
  afterEach(() => sqlite.close());
  const req = () => new Request(`${origin}/api/admin/feedback/${feedbackId}/analyze`, {
    method: 'POST',
    headers: { origin, 'cf-access-jwt-assertion': jwt },
  });
  const provider = (text: string) => Response.json({
    model: 'gemini-3.5-flash-lite',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 100, total_output_tokens: 20, total_tokens: 120 },
  });
  const routedFetch = (geminiBody: string) => {
    const providerCalls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(`${teamDomain}/cdn-cgi/access/certs`)) {
        return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
      }
      providerCalls.push(init);
      return provider(geminiBody);
    };
    return { fetchImpl, providerCalls };
  };

  it('analyzes only sanitized content and records provider cost on admin-operator plus access:<sub> audit', async () => {
    const { fetchImpl, providerCalls } = routedFetch(JSON.stringify({ kind: 'bug', title: '保存失敗', reply: '操作と期待する動作: 未確認。' }));
    const response = await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now });
    expect(response.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    const sent = String(providerCalls[0]?.body);
    expect(sent).not.toContain('person@example.test'); expect(sent).not.toContain('private-value');
    expect(sqlite.prepare('SELECT user_id FROM ai_provider_cost_events').all()).toEqual([{ user_id: ADMIN_OPERATOR_PRINCIPAL_ID }]);
    expect(sqlite.prepare('SELECT user_id FROM ai_receipt_flows').all()).toEqual([{ user_id: ADMIN_OPERATOR_PRINCIPAL_ID }]);
    expect(sqlite.prepare('SELECT admin_user_id, action FROM admin_audit_log ORDER BY rowid').all()).toEqual([
      { admin_user_id: 'access:op-sub-1', action: 'feedback_analysis_requested' },
      { admin_user_id: 'access:op-sub-1', action: 'feedback_analyzed' },
    ]);
  });

  it('respects emergency stop before dispatch and records invalid responses as errors', async () => {
    const { fetchImpl, providerCalls } = routedFetch('invalid JSON');
    env.AI_EMERGENCY_STOP = 'true';
    expect((await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now })).status).toBe(503);
    expect(providerCalls).toHaveLength(0);
    env.AI_EMERGENCY_STOP = 'false';
    expect((await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now })).status).toBe(502);
    expect(sqlite.prepare('SELECT user_id, safe_error_code FROM ai_provider_cost_events').get()).toEqual({
      user_id: ADMIN_OPERATOR_PRINCIPAL_ID,
      safe_error_code: 'invalid_provider_response',
    });
    expect(sqlite.prepare('SELECT ai_summary FROM feedback_submissions').get()?.ai_summary).toBeNull();
  });
});
