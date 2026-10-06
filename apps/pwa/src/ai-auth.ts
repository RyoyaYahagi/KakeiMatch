import { forgetGuestSecret, startGuest, storedGuestSecret } from './guest-ai';

type TokenResponse = { token: string; expiresAt: number };
export type AiIdentity = 'account' | 'guest';

let cachedToken: (TokenResponse & { identity: AiIdentity }) | null = null;

async function requestToken(headers: Record<string, string>): Promise<Response> {
  return fetch('/api/ai/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers },
  });
}
async function readToken(response: Response, identity: AiIdentity): Promise<string> {
  const result = await response.json() as TokenResponse;
  if (typeof result.token !== 'string' || !result.token || !Number.isSafeInteger(result.expiresAt)) {
    throw new Error('invalid_ai_token_response');
  }
  cachedToken = { ...result, identity };
  return result.token;
}

/**
 * Get an in-memory AI JWT, refreshing it silently when near expiry. A signed-in
 * account is used first; otherwise this device's guest, created after a bot check
 * when there is none yet. `allowGuest: false` asks only about the account session.
 */
export async function getAiAccessToken({ allowGuest = true }: { allowGuest?: boolean } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30 && (allowGuest || cachedToken.identity === 'account')) return cachedToken.token;

  const account = await requestToken({});
  if (account.ok) return readToken(account, 'account');
  if (account.status !== 401) throw new Error('ai_token_unavailable');
  if (!allowGuest) throw new Error('account_session_required');

  const saved = storedGuestSecret();
  if (saved) {
    const guest = await requestToken({ authorization: `Guest ${saved}` });
    if (guest.ok) return readToken(guest, 'guest');
    if (guest.status !== 401) throw new Error('ai_token_unavailable');
    // The guest was retired elsewhere or the server forgot it; start a new one.
    forgetGuestSecret();
  }
  const created = await requestToken({ authorization: `Guest ${await startGuest()}` });
  if (!created.ok) throw new Error('ai_token_unavailable');
  return readToken(created, 'guest');
}

/** Whether the last AI token came from an account or this device's guest. */
export function currentAiIdentity(): AiIdentity | null {
  return cachedToken?.identity ?? null;
}

/** Drop the in-memory token on logout so it cannot be reused by later local UI state. */
export function clearAiAccessToken() {
  cachedToken = null;
}
