import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type GatewayEnv, type AccountD1Binding } from './worker';
import { parseContactInput, parseContactInterviewInput, parseContactInterview, parseDiagnosticContext } from './contact';
import { monthlyCosts } from './ai-provider-costs';
import { sqliteD1 } from './test-support/sqlite-d1';

const origin = 'https://contact.example.test';
const secret = 'synthetic-contact-signing-secret';
const now = Date.parse('2026-10-03T03:00:00Z') / 1000;
const flowId = '12345678-1234-4123-8123-123456789abc';
function bearer(user = 'synthetic-user') {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: user, aud: 'kakeimatch-ai', iat: now, exp: now + 300 })).toString('base64url');
  return `Bearer ${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
function request(body: unknown, path = '/api/contact', headers: Record<string,string> = {}) {
  return new Request(origin + path, { method: 'POST', headers: { origin, authorization: bearer(), 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const message = { flowId, kind: 'bug', message: '合成テスト: 記録を追加すると保存が失敗します。' };
const wav = Buffer.from('RIFF0000WAVEsynthetic-audio').toString('base64');
const audio = { flowId, audioBase64: wav, contentType: 'audio/wav' };
const diagnostic = {
  version: 1 as const,
  currentScreen: 'records',
  network: 'online',
  events: [
    { type: 'screen_open', secondsAgo: 12, screen: 'records' },
    { type: 'error', secondsAgo: 8, screen: 'records', errorCode: 'storage' },
  ],
};
const interview = { flowId, message: '入力が面倒です', history: [], finish: false, diagnostic };
function provider(text: string, model = 'gemini-3.5-flash-lite') {
  return { model, steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_input_tokens: 100, total_output_tokens: 20, total_tokens: 120 } };
}
describe('contact Gateway with real SQLite migrations', () => {
  let sqlite: DatabaseSync; let env: GatewayEnv; let db: AccountD1Binding;
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
    sqlite.exec("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Synthetic','synthetic@example.test',0,0),('another-user','Another','another@example.test',0,0)");
    db = sqliteD1(sqlite);
    env = { ACCOUNT_DB: db, AI_GATEWAY_AUTH_SECRET: secret, GEMINI_API_KEY: 'synthetic-gemini',
      GITHUB_ISSUES_TOKEN: 'synthetic-github', GITHUB_ISSUES_REPOSITORY: 'Synthetic/Contact', FEEDBACK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) }, CONTACT_RATE_LIMIT: { limit: async () => ({ success: true }) } };
  });
  afterEach(() => sqlite.close());
  const run = (req: Request, fetchImpl: typeof fetch) => handleRequest(req, env, { nowSeconds: () => now, fetchImpl });
  it('saves a sanitized inquiry to the internal Inbox and reuses the idempotent result without AI or GitHub calls', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await run(request(message), fetchImpl);
    const result = await response.json() as { feedbackId: string; kind: string; issueUrl: string | null };
    expect(response.status).toBe(200); expect(result).toMatchObject({ kind: 'bug', issueUrl: null });
    expect(result.feedbackId).toBeTruthy(); expect(fetchImpl).not.toHaveBeenCalled();
    expect((await run(request(message), fetchImpl)).status).toBe(200); expect(fetchImpl).not.toHaveBeenCalled();
    const row = sqlite.prepare('SELECT * FROM contact_submissions').get(); expect(JSON.stringify(row)).not.toContain(message.message);
    const feedback = sqlite.prepare('SELECT message_sanitized,message_original_encrypted,retention_expires_at FROM feedback_submissions').get() as { message_sanitized: string; message_original_encrypted: string; retention_expires_at: number };
    expect(feedback.message_sanitized).toContain(message.message);
    expect(feedback.message_original_encrypted).not.toContain(message.message);
    expect(feedback.retention_expires_at).toBe(now + 90 * 24 * 60 * 60);
    const costs = await monthlyCosts(db, 'synthetic-user', '2026-10'); expect(costs.providers.gemini.requests).toBe(0);
  });
  it.each(['improvement', 'question'])('stores the user-selected %s kind without classifying or publishing', async kind => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await run(request({ ...message, kind }), fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind, issueUrl: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT kind FROM feedback_submissions').get()).toEqual({ kind });
  });
  it('asks one non-technical interview question and can return a bounded ready summary', async () => {
    const ask = provider(JSON.stringify({ status: 'ask', kind: 'improvement', question: 'どの場面で一番手間に感じますか？', recommendation: '品目を入力する場面です。', summary: '' }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(ask));
    const response = await run(request(interview, '/api/contact/interview'), fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ask', kind: 'improvement', question: 'どの場面で一番手間に感じますか？', recommendation: '品目を入力する場面です。', summary: '' });
    const payload = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(payload.store).toBe(false);
    expect(payload.input[1].text).toContain('TRUSTED_PRODUCT_CONTEXT');
    expect(payload.input[1].text).toContain('local-first household ledger PWA');
    expect(JSON.parse(payload.input[2].text)).toEqual({
      userReport: interview.message,
      interviewHistory: [],
      finish: false,
      sanitizedDiagnosticContext: diagnostic,
    });
    expect(JSON.stringify(payload.input[1])).not.toContain(interview.message);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get()?.n).toBe(0);

    const readyInput = { ...interview, flowId: crypto.randomUUID(), history: [{ question: 'どの場面で一番手間に感じますか？', answer: '品目を入力する場面です。' }] };
    const ready = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider(JSON.stringify({
      status: 'ready', kind: 'improvement', question: '', recommendation: '',
      summary: '困っていること: 品目入力が手間。\n期待すること: 少ない操作で入力したい。\n再現条件: 未確認。',
    }))));
    const readyResponse = await run(request(readyInput, '/api/contact/interview'), ready);
    expect(readyResponse.status).toBe(200);
    expect((await readyResponse.json() as { status: string }).status).toBe('ready');
  });
  it('stores the final sanitized report and diagnostics while keeping secret-stripped original encrypted', async () => {
    const refined = { flowId, kind: 'improvement', message: '困っていること: 保存できない。\n期待すること: 正常に保存したい。\n再現条件: 未確認。', originalMessage: '保存できなくて困っています Authorization: Bearer abc.def', diagnostic };
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await run(request(refined), fetchImpl);
    expect(response.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    const stored = sqlite.prepare('SELECT message_original_encrypted,message_sanitized,diagnostic_json_sanitized FROM feedback_submissions').get() as { message_original_encrypted: string; message_sanitized: string; diagnostic_json_sanitized: string };
    expect(stored.message_original_encrypted).not.toContain('保存できなくて困っています');
    expect(stored.message_sanitized).toContain(refined.message);
    expect(stored.diagnostic_json_sanitized).toContain('storage');
    expect(stored.diagnostic_json_sanitized).toContain('records');
    expect(stored.diagnostic_json_sanitized).not.toContain('private');
    const row = sqlite.prepare('SELECT * FROM contact_submissions').get();
    expect(JSON.stringify(row)).not.toContain(refined.originalMessage);
    expect(JSON.stringify(row)).not.toContain(refined.message);
  });
  it('sends Base64 audio inline with transcribe model and meters its price', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider('合成の音声入力です。', 'gemini-3.5-transcribe')));
    const response = await run(request(audio, '/api/contact/transcribe'), fetchImpl);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: '合成の音声入力です。' });
    const payload = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(payload.model).toBe('gemini-3.5-transcribe'); expect(payload.input).toEqual([{ type: 'audio', data: wav, mime_type: 'audio/wav' }]); expect(payload.store).toBe(false);
    const costs = await monthlyCosts(db, 'synthetic-user', '2026-10'); expect(costs.totalUsdMicros).toBe(440); expect(costs.unknownRequests).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get()?.n).toBe(0);
  });
  it('maps Safari MP4 audio to the documented M4A provider MIME type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider('合成の音声', 'gemini-3.5-transcribe')));
    const mp4 = Buffer.from('0000ftypM4A synthetic-audio').toString('base64');
    expect((await run(request({ ...audio, audioBase64: mp4, contentType: 'audio/mp4' }, '/api/contact/transcribe'), fetchImpl)).status).toBe(200);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).input[0].mime_type).toBe('audio/m4a');
  });
  it('rejects unauthenticated and cross-origin requests before dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await run(request(message, '/api/contact', { authorization: '' }), fetchImpl)).status).toBe(401);
    expect((await run(request(message, '/api/contact', { origin: 'https://evil.example.test' }), fetchImpl)).status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps transcription behind provider pause and rate limits, but saves final Inbox submissions without AI quota', async () => {
    const fetchImpl = vi.fn<typeof fetch>(); env.AI_EMERGENCY_STOP = 'true';
    const response = await run(request(audio, '/api/contact/transcribe'), fetchImpl); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'ai_temporarily_paused' });
    env.AI_EMERGENCY_STOP = 'false'; env.AI_USER_RATE_LIMIT = { limit: async () => ({ success: false }) }; expect((await run(request(message), fetchImpl)).status).toBe(429);
    env.AI_USER_RATE_LIMIT = { limit: async () => ({ success: true }) };
    // Contact features have their own per-identity and per-address limit.
    const keys: string[] = [];
    env.CONTACT_RATE_LIMIT = { limit: async ({ key }) => { keys.push(key); return { success: !key.startsWith('contact-address:') }; } };
    expect((await run(request(audio, '/api/contact/transcribe'), fetchImpl)).status).toBe(429); expect(fetchImpl).not.toHaveBeenCalled();
    expect(keys).toEqual(['contact:synthetic-user', expect.stringMatching(/^contact-address:[0-9a-f]{64}$/)]);
    env.CONTACT_RATE_LIMIT = { limit: async () => ({ success: true }) }; env.AI_FREE_MONTHLY_LIMIT = '1';
    sqlite.exec("INSERT INTO ai_receipt_flows(user_id,flow_id,month,created_at,image_mac,dispatched) VALUES ('synthetic-user','existing','2026-10',1,'synthetic',1)");
    // A used-up receipt quota does not stop a transcription, which is not counted.
    const transcribed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider('合成の問い合わせ本文')));
    expect((await run(request(audio, '/api/contact/transcribe'), transcribed)).status).toBe(200);
    expect(sqlite.prepare("SELECT kind FROM ai_receipt_flows WHERE flow_id = ?").get(audio.flowId)).toEqual({ kind: 'contact-transcribe' });
  });
  it('rejects malformed final submission kinds and invalid interview/audio provider output', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await run(request({ ...message, kind: 'not-a-kind' }), fetchImpl)).status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
    const badInterview = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider(JSON.stringify({
      status: 'ask', kind: 'bug', question: '何が起きましたか？', recommendation: '', summary: '',
    }))));
    expect((await run(request({ ...interview, flowId: crypto.randomUUID() }, '/api/contact/interview'), badInterview)).status).toBe(502);
    const blank = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(provider('   ', 'gemini-3.5-transcribe')));
    expect((await run(request({ ...audio, flowId: crypto.randomUUID() }, '/api/contact/transcribe'), blank)).status).toBe(502);
  });
  it('binds idempotency to contents and user, rejects cross-endpoint flow replay', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await run(request(message), fetchImpl)).status).toBe(200);
    expect((await run(request({ ...message, message: 'changed' }), fetchImpl)).status).toBe(409);
    expect((await run(request(audio, '/api/contact/transcribe'), fetchImpl)).status).toBe(409);
    const another = vi.fn<typeof fetch>();
    expect((await run(request(message, '/api/contact', { authorization: bearer('another-user') }), another)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get()?.n).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(another).not.toHaveBeenCalled();
  });
  it('serializes concurrent inbox submissions and never dispatches AI or GitHub', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const responses = await Promise.all([run(request(message), fetchImpl), run(request(message), fetchImpl)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback_submissions').get()?.n).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('fails closed without an encryption key and rejects unexpected request fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(); env.GITHUB_ISSUES_TOKEN = undefined;
    env.FEEDBACK_ENCRYPTION_KEY = undefined;
    expect((await run(request(message), fetchImpl)).status).toBe(503);
    expect((await run(request({ ...message, repository: 'evil/repo' }), fetchImpl)).status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback_submissions').get()?.n).toBe(0);
  });
});
it('rejects oversize, invalid encodings, malformed interview history and mismatched audio headers', () => {
  expect(parseContactInput({ ...audio, audioBase64: '!!!!' }, true)).toBeNull();
  expect(parseContactInput({ ...audio, contentType: 'audio/mp4' }, true)).toBeNull();
  expect(parseContactInput({ ...audio, audioBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }, true)).toBeNull();
  expect(parseContactInput({ ...message, message: 'x'.repeat(4001) }, false)).toBeNull();
  expect(parseContactInput({ ...message, originalMessage: 'x'.repeat(4001) }, false)).toBeNull();
  expect(parseContactInterviewInput({ ...interview, history: Array.from({ length: 5 }, () => ({ question: 'q', answer: 'a' })) })).toBeNull();
  expect(parseContactInterviewInput({ ...interview, history: [{ question: 'q', answer: '' }] })).toBeNull();
  expect(parseDiagnosticContext({ ...diagnostic, events: [{ type: 'error', secondsAgo: 1, screen: 'records', errorCode: 'secret_user_text' }] })).toBeNull();
  expect(parseDiagnosticContext({ ...diagnostic, currentScreen: 'receipt:private-id' })).toBeNull();
  expect(parseContactInput({ ...message, diagnostic: { ...diagnostic, extra: 'private' } }, false)).toBeNull();
  expect(() => parseContactInterview(JSON.stringify({ status: 'ready', kind: 'bug', question: 'extra', recommendation: '', summary: 'summary' }))).toThrow('invalid_provider_response');
});
