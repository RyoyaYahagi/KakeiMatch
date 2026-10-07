import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './test-support/sqlite-d1';
import { analyzeFeedback, createFeedbackIssue, deleteFeedback, getFeedback, listFeedback, purgeExpiredFeedback, revealFeedbackOriginal, submitContactToInbox, updateFeedbackStatus } from './feedback';
import { sanitizeFeedbackDiagnostics, sanitizeFeedbackMessage } from './feedback-sanitizer';

const encryptionKey = Buffer.alloc(32, 7).toString('base64url');
const now = 1_800_000_000;
const unsafeMessage = '保存に失敗します。連絡先 test@example.com、token: abc123secret、Authorization: Bearer abc.def';

describe('feedback Inbox persistence and admin operations', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof sqliteD1>;
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    sqlite.exec("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('feedback-user','Synthetic','synthetic@example.test',0,0)");
    db = sqliteD1(sqlite);
  });
  afterEach(() => sqlite.close());

  it('redacts common provider keys and accepts only whitelisted diagnostics', () => {
    const clean = sanitizeFeedbackMessage('password: "top-secret" Google AIza123456789012345678901234567890 OpenAI sk-proj-123456789012345678901234567890');
    expect(clean).not.toContain('top-secret');
    expect(clean).not.toContain('AIza');
    expect(clean).not.toContain('sk-proj');
    expect(sanitizeFeedbackDiagnostics({ version: 1, currentScreen: 'records', network: 'online', events: [] })).not.toBeNull();
    expect(sanitizeFeedbackDiagnostics({ version: 1, currentScreen: 'records', network: 'online', events: [], message: 'private' })).toBeNull();
  });

  it('stores sanitized text, encrypts secret-stripped original, and idempotently returns the same inbox row', async () => {
    const input = { db, user: 'feedback-user', flowId: 'flow-1', inputMac: 'hmac-a', kind: 'bug' as const,
      message: unsafeMessage, originalMessage: unsafeMessage, diagnostic: { version: 1, network: 'online' }, encryptionKey, now };
    const first = await submitContactToInbox(input);
    const retry = await submitContactToInbox(input);
    expect(retry).toEqual(first);
    expect(first.issueUrl).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM feedback_submissions').get()).toEqual({ count: 1 });
    const stored = sqlite.prepare('SELECT message_sanitized,message_original_encrypted FROM feedback_submissions').get() as { message_sanitized: string; message_original_encrypted: string };
    expect(stored.message_sanitized).not.toContain('test@example.com');
    expect(stored.message_sanitized).not.toContain('abc123secret');
    expect(stored.message_original_encrypted).not.toContain('保存に失敗');
    expect(await revealFeedbackOriginal({ db, adminUserId: 'admin', id: first.feedbackId, encryptionKey, now })).toEqual({ message: '保存に失敗します。連絡先 test@example.com、[秘密情報を削除] [秘密情報を削除]' });
    expect(sqlite.prepare('SELECT action FROM admin_audit_log').get()).toEqual({ action: 'feedback_original_viewed' });
    expect((await listFeedback({ db, adminUserId: 'admin' })).items[0]).toMatchObject({ id: first.feedbackId, kind: 'bug', status: 'reviewing' });
    await expect(submitContactToInbox({ ...input, inputMac: 'different-hmac' })).rejects.toThrow('invalid_flow');
  });

  it('fails closed without an encryption key and rejects invalid contact kinds', async () => {
    await expect(submitContactToInbox({ db, user: 'feedback-user', flowId: 'flow-x', inputMac: 'hmac', kind: 'question', message: '本文', now }))
      .rejects.toThrow('not_configured');
    await expect(submitContactToInbox({ db, user: 'feedback-user', flowId: 'flow-y', inputMac: 'hmac', kind: 'other' as never, message: '本文', encryptionKey, now }))
      .rejects.toThrow('not_configured');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM contact_submissions').get()).toEqual({ count: 0 });
  });

  it('analyzes only sanitized data and creates one GitHub issue from a validated callback result', async () => {
    const saved = await submitContactToInbox({ db, user: 'feedback-user', flowId: 'flow-2', inputMac: 'hmac-b', kind: 'improvement', message: unsafeMessage, encryptionKey, now });
    const analyze = vi.fn(async (payload: { message: string }) => {
      expect(payload.message).not.toContain('test@example.com');
      expect(payload.message).not.toContain('abc123secret');
      return '保存操作が失敗するとの報告。原因は未確認。';
    });
    expect(await analyzeFeedback({ db, adminUserId: 'admin', id: saved.feedbackId, analyze, now })).toEqual({ aiSummary: '保存操作が失敗するとの報告。原因は未確認。' });
    const createIssue = vi.fn(async (payload: { title: string; body: string; idempotencyMarker: string }) => {
      expect(payload.body).toContain(`feedback_id: \`${saved.feedbackId}\``);
      expect(payload.body).not.toContain('test@example.com');
      expect(payload.body).toContain('管理者が確認した開発向けの再現内容');
      expect(payload.body).not.toContain('保存に失敗します');
      return { number: 27, url: 'https://github.com/Synthetic/Contact/issues/27' };
    });
    const args = { db, adminUserId: 'admin', id: saved.feedbackId, repo: 'Synthetic/Contact', token: 'only-used-as-config-check',
      draft: { title: '保存エラーの再現確認', body: '管理者が確認した開発向けの再現内容' }, createIssue, now };
    expect(await createFeedbackIssue(args)).toEqual({ issueNumber: 27, issueUrl: 'https://github.com/Synthetic/Contact/issues/27' });
    expect(await createFeedbackIssue(args)).toEqual({ issueNumber: 27, issueUrl: 'https://github.com/Synthetic/Contact/issues/27' });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(await getFeedback({ db, adminUserId: 'admin', id: saved.feedbackId, now })).toMatchObject({ status: 'issue_created', githubIssueNumber: 27 });
    expect(sqlite.prepare('SELECT action FROM admin_audit_log ORDER BY created_at').all().map(row => row.action)).toEqual(['feedback_analysis_requested', 'feedback_analyzed', 'feedback_issue_requested', 'feedback_issue_created']);
  });

  it('audits status changes and deletion, and removes records after the 90 day retention window', async () => {
    const first = await submitContactToInbox({ db, user: 'feedback-user', flowId: 'flow-3', inputMac: 'hmac-c', kind: 'question', message: '質問です', encryptionKey, now });
    await updateFeedbackStatus({ db, adminUserId: 'admin', id: first.feedbackId, status: 'resolved', now });
    expect(await getFeedback({ db, adminUserId: 'admin', id: first.feedbackId, now })).toMatchObject({ status: 'resolved', resolvedAt: now });
    expect(await purgeExpiredFeedback(db, now + 90 * 24 * 60 * 60)).toBe(1);
    await expect(getFeedback({ db, adminUserId: 'admin', id: first.feedbackId, now })).rejects.toThrow('not_found');
    const second = await submitContactToInbox({ db, user: 'feedback-user', flowId: 'flow-4', inputMac: 'hmac-d', kind: 'question', message: 'もう一つの質問です', encryptionKey, now: now + 1 });
    await deleteFeedback({ db, adminUserId: 'admin', id: second.feedbackId, now: now + 2 });
    expect(sqlite.prepare("SELECT action FROM admin_audit_log WHERE target_id=?").get(second.feedbackId)).toEqual({ action: 'feedback_deleted' });
  });
});
