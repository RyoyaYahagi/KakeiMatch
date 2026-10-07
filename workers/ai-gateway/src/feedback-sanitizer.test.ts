import { expect, it } from 'vitest';
import { removeFeedbackSecrets, sanitizeFeedbackDiagnostics } from './feedback-sanitizer';
it('removes quoted credential values containing spaces before encrypted persistence', () => {
  const message = '報告 {"password": "secret phrase with spaces", "Cookie": "session=private cookie", "Authorization": "Basic private header"}';
  const clean = removeFeedbackSecrets(message);
  for (const secret of ['secret phrase', 'private cookie', 'private header']) expect(clean).not.toContain(secret);
  expect(clean).toContain('報告');
});
it('drops unknown diagnostic keys instead of persisting free-form data', () => {
  expect(sanitizeFeedbackDiagnostics({ version: 1, currentScreen: 'records', network: 'online', events: [], merchant: 'private merchant' })).toBeNull();
});
