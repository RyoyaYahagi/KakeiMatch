import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminGatewayRequest, type GatewayEnv } from './worker';
import type { AdminEnv } from './admin';
import { submitContactToInbox } from './feedback';
import { sqliteD1 } from './test-support/sqlite-d1';

vi.mock('./account-auth', async importOriginal => ({
  ...await importOriginal<typeof import('./account-auth')>(),
  getAccountSession: async () => ({ user: { id: 'synthetic-admin' } }),
}));
const now = Date.parse('2026-10-08T03:00:00Z') / 1000;
const origin = 'https://admin.example.test';
const key = Buffer.alloc(32, 7).toString('base64url');
describe('metered admin feedback analysis', () => {
  let sqlite: DatabaseSync; let env: GatewayEnv & AdminEnv; let feedbackId: string;
  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
    sqlite.exec("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-admin','Synthetic','admin@example.test',0,0)");
    env = { ACCOUNT_DB: sqliteD1(sqlite), BETTER_AUTH_SECRET: 'synthetic-better-auth-secret',
      ADMIN_USER_IDS: 'synthetic-admin', AI_GATEWAY_AUTH_SECRET: 'synthetic-signing-secret',
      GEMINI_API_KEY: 'synthetic-provider-key', FEEDBACK_ENCRYPTION_KEY: key,
      CONTACT_RATE_LIMIT: { limit: async () => ({ success: true }) } };
    const result = await submitContactToInbox({ db: env.ACCOUNT_DB, user: 'synthetic-admin', flowId: crypto.randomUUID(),
      inputMac: 'synthetic-mac', kind: 'bug', message: '保存できません。secret=private-value email=person@example.test', encryptionKey: key, now });
    feedbackId = result.feedbackId;
  });
  afterEach(() => sqlite.close());
  const req = () => new Request(`${origin}/api/admin/feedback/${feedbackId}/analyze`, { method: 'POST', headers: { origin } });
  const provider = (text: string) => Response.json({ model: 'gemini-3.5-flash-lite', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 100, total_output_tokens: 20, total_tokens: 120 } });
  it('analyzes only sanitized content and records provider cost plus admin audit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(provider(JSON.stringify({ kind: 'bug', title: '保存失敗', reply: '操作と期待する動作: 未確認。' })));
    const response = await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now });
    expect(response.status).toBe(200);
    const sent = String(fetchImpl.mock.calls[0][1]?.body);
    expect(sent).not.toContain('person@example.test'); expect(sent).not.toContain('private-value');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_provider_cost_events').get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='feedback_analyzed'").get()?.n).toBe(1);
  });
  it('respects emergency stop before dispatch and records invalid responses as errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(provider('invalid JSON'));
    env.AI_EMERGENCY_STOP = 'true';
    expect((await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now })).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    env.AI_EMERGENCY_STOP = 'false';
    expect((await handleAdminGatewayRequest(req(), env, { fetchImpl, nowSeconds: () => now })).status).toBe(502);
    expect(sqlite.prepare('SELECT safe_error_code FROM ai_provider_cost_events').get()?.safe_error_code).toBe('invalid_provider_response');
    expect(sqlite.prepare('SELECT ai_summary FROM feedback_submissions').get()?.ai_summary).toBeNull();
  });
});
