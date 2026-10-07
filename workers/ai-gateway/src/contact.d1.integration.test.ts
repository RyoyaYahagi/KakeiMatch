import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { submitContactToInbox } from './feedback';

it('applies the feedback Inbox migration to D1 and serializes concurrent idempotent submissions', async () => {
  const instance = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true, compatibilityDate: '2026-08-01', d1Databases: { ACCOUNT_DB: 'contact-synthetic-test' } });
  try {
    const db = await instance.getD1Database('ACCOUNT_DB');
    for (const name of ['0001_auth.sql', '0006_contact_submissions.sql', '0016_feedback_inbox.sql']) {
      await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\s+/g, ' '));
    }
    await db.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Test','test@example.invalid',0,0)").run();
    const context = { db, user: 'synthetic-user', inputMac: 'synthetic-input-hmac', kind: 'bug' as const,
      flowId: crypto.randomUUID(), message: '合成問い合わせの保存エラー。連絡先 hello@example.invalid',
      encryptionKey: Buffer.alloc(32, 8).toString('base64url'), now: 100 };
    const [first, second] = await Promise.allSettled([submitContactToInbox(context), submitContactToInbox(context)]);
    const successful = [first, second].find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof submitContactToInbox>>> => result.status === 'fulfilled');
    expect(successful).toBeDefined();
    const result = successful!.value;
    expect((await submitContactToInbox(context)).feedbackId).toBe(result.feedbackId);
    const row = await db.prepare('SELECT state,kind,feedback_id FROM contact_submissions').first();
    expect(row).toMatchObject({ state: 'done', kind: 'bug', feedback_id: result.feedbackId });
    const stored = await db.prepare('SELECT message_sanitized,message_original_encrypted FROM feedback_submissions').first<{ message_sanitized: string; message_original_encrypted: string }>();
    expect(stored?.message_sanitized).not.toContain('hello@example.invalid');
    expect(stored?.message_original_encrypted).not.toContain('合成問い合わせ');
  } finally { await instance.dispose(); }
});
