import { describe, expect, it } from 'vitest';
import worker from './hosting';
import { parseDiagnosticContext } from './contact';

const diagnostic = {
  version: 1 as const,
  currentScreen: 'records',
  network: 'online',
  events: [
    { type: 'screen_open', secondsAgo: 12, screen: 'records' },
    { type: 'error', secondsAgo: 8, screen: 'records', errorCode: 'storage' },
  ],
};

describe('contact intake after the account features were retired', () => {
  it.each(['/api/contact', '/api/contact/transcribe', '/api/contact/interview'])('answers %s with 410 at the Worker edge', async path => {
    const response = await worker.fetch(new Request(`https://contact.example.test${path}`, { method: 'POST' }), {} as never);
    expect(response.status).toBe(410);
  });

  it('rejects diagnostic context that carries user text or identifiers', () => {
    expect(parseDiagnosticContext({ ...diagnostic, events: [{ type: 'error', secondsAgo: 1, screen: 'records', errorCode: 'secret_user_text' }] })).toBeNull();
    expect(parseDiagnosticContext({ ...diagnostic, currentScreen: 'receipt:private-id' })).toBeNull();
    expect(parseDiagnosticContext({ ...diagnostic, extra: 'private' })).toBeNull();
  });
});
