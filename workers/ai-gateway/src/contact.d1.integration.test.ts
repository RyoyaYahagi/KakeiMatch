import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { expect, it, vi } from 'vitest';
import { submitContact } from './contact';

it('applies contact migration to D1 and serializes concurrent publication with no inquiry body stored', async () => {
  const instance = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true, compatibilityDate: '2026-08-01', d1Databases: { ACCOUNT_DB: 'contact-synthetic-test' } });
  try {
    const db = await instance.getD1Database('ACCOUNT_DB');
    for (const name of ['0001_auth.sql', '0006_contact_submissions.sql']) await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\s+/g, ' '));
    await db.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Test','test@example.invalid',0,0)").run();
    let finish!: (text: string) => void;
    const classify = vi.fn(async () => new Promise<string>(resolve => { finish = resolve; }));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ number: 321, html_url: 'https://github.com/Synthetic/Contact/issues/321' }, { status: 201 }));
    const context = { db, user: 'synthetic-user', secret: 'synthetic-contact-d1-secret', env: { GITHUB_ISSUES_TOKEN: 'synthetic', GITHUB_ISSUES_REPOSITORY: 'Synthetic/Contact' }, flowId: crypto.randomUUID(), message: '合成問い合わせの保存エラー', now: 100, classify, fetchImpl };
    const first = submitContact(context);
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    await expect(submitContact(context)).rejects.toThrow('temporarily_unavailable');
    finish(JSON.stringify({ kind: 'bug', title: '合成の保存エラー', reply: '合成の回答' }));
    expect((await first).issueUrl).toBe('https://github.com/Synthetic/Contact/issues/321');
    expect((await submitContact(context)).issueUrl).toBe('https://github.com/Synthetic/Contact/issues/321');
    expect(classify).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const row = await db.prepare('SELECT * FROM contact_submissions').first();
    expect(row).toMatchObject({ state: 'done', kind: 'bug', issue_number: 321 });
    expect(JSON.stringify(row)).not.toContain(context.message);
  } finally { await instance.dispose(); }
});
